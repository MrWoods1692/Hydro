import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import moment from 'moment-timezone';
import { Binary } from 'mongodb';
import Schema from 'schemastery';
import { randomstring } from '@hydrooj/utils';
import type { Context } from '../context';
import {
    AuthOperationError, BadRequestError, BlacklistedError, BuiltinLoginError,
    ForbiddenError, InvalidTokenError, NotFoundError,
    SystemError, UserAlreadyExistError, UserFacingError,
    UserNotFoundError, ValidationError, VerifyPasswordError,
} from '../error';
import { TokenDoc, Udoc, User } from '../interface';
import avatar from '../lib/avatar';
import { sendMail } from '../lib/mail';
import { verifyTFA } from '../lib/verifyTFA';
import BlackListModel from '../model/blacklist';
import { PERM, PRIV, STATUS } from '../model/builtin';
import * as ContestModel from '../model/contest';
import domain from '../model/domain';
import * as oplog from '../model/oplog';
import problem, { ProblemDoc } from '../model/problem';
import ScheduleModel from '../model/schedule';
import SolutionModel from '../model/solution';
import system from '../model/system';
import token from '../model/token';
import user, { deleteUserCache } from '../model/user';
import {
    Handler, param, post, Query, Types,
} from '../service/server';

async function successfulAuth(this: Handler, udoc: User) {
    if (udoc._id !== 0) {
        await this.ctx.serial('auth/before-login', this, udoc);
        const now = new Date();
        const raw = (udoc as any)._udoc || {};
        await user.setById(udoc._id, {
            loginat: now,
            // 注册时间口径：最早一次登录时间。新账号首次登录即记；老账号回填最早可考时间（regat），避免把补记时刻当成首次登录。
            ...(raw.firstLogin ? {} : { firstLogin: raw.regat || now }),
            loginip: this.request.ip,
        });
        // 默认授予持久会话（30 天）：OAuth/WebAuthn 登录路径不会设置 session.save，
        // 不设默认会落入 3 小时的未保存会话导致频繁掉线；账号密码登录的 rememberme
        // 在调用本函数之后另行赋值，仍可覆盖此默认值。
        this.session.save = true;
    }
    this.context.HydroContext.user = udoc;
    this.session.viewLang = '';
    this.session.uid = udoc._id;
    this.session.sudo = null;
    this.session.sudoUid = null;
    this.session.scope = PERM.PERM_ALL.toString();
    this.session.oauthBind = null;
    this.session.recreate = true;
    if (udoc._id !== 0) {
        await oplog.log(this, 'user.loginSuccess', { uid: udoc._id });
        await this.ctx.serial('auth/login', this, udoc);
    }
}

class UserLoginHandler extends Handler {
    noCheckPermView = true;

    @param('redirect', Types.String, true)
    async get(domainId: string, redirect: string = '') {
        this.response.template = 'user_login.html';
        this.response.body = {
            redirect,
            builtInLogin: system.get('server.login'),
            loginMethods: this.loginMethods,
        };
    }

    @param('uname', Types.Username)
    @param('password', Types.Password)
    @param('rememberme', Types.Boolean)
    @param('redirect', Types.String, true)
    @param('tfa', Types.String, true)
    @param('authnChallenge', Types.String, true)
    @param('judge', Types.Boolean, true)
    async post(
        domainId: string, uname: string, password: string, rememberme = false, redirect = '',
        tfa = '', authnChallenge = '', judge = false,
    ) {
        if (!system.get('server.login')) throw new BuiltinLoginError();
        let udoc = await user.getByEmail(domainId, uname);
        udoc ||= await user.getByUname(domainId, uname);
        if (!udoc) throw new UserNotFoundError(uname);
        if (system.get('system.contestmode') && !udoc.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
            if (udoc._loginip && udoc._loginip !== this.request.ip) throw new ValidationError('ip');
            if (system.get('system.contestmode') === 'strict') {
                const udocs = await user.getMulti({ loginip: this.request.ip, _id: { $ne: udoc._id } }).toArray();
                if (udocs.length) throw new ValidationError('ip');
            }
        }
        await Promise.all([
            this.limitRate('user_login', 60, 30),
            this.limitRate('user_login_id', 60, 5, uname),
            oplog.log(this, 'user.login', { redirect }),
        ]);
        if (udoc.tfa || udoc.authn) {
            if (udoc.tfa && tfa) {
                if (!verifyTFA(udoc._tfa, tfa)) throw new InvalidTokenError('2FA');
            } else if (udoc.authn && authnChallenge) {
                const challenge = await token.get(authnChallenge, token.TYPE_WEBAUTHN);
                if (!challenge || challenge.uid !== udoc._id) throw new InvalidTokenError(token.TYPE_TEXTS[token.TYPE_WEBAUTHN]);
                if (!challenge.verified) throw new ValidationError('challenge');
                await token.del(authnChallenge, token.TYPE_WEBAUTHN);
            } else throw new ValidationError('2FA', 'Authn');
        }
        await udoc.checkPassword(password);
        if (!udoc.hasPriv(PRIV.PRIV_USER_PROFILE)) throw new BlacklistedError(uname, udoc.banReason);
        await successfulAuth.call(this, udoc);
        this.session.save = rememberme;
        this.response.redirect = redirect || ((this.request.referer || '/login').endsWith('/login')
            ? this.url('homepage') : this.request.referer);
    }
}

class UserSudoHandler extends Handler {
    async get() {
        // 控制面板等敏感操作不再要求密码确认：能触达 sudo 页的已登录用户直接放行，
        // 具体操作的权限仍由对应 handler 的 priv/perm 检查兜底。
        if (!this.session.sudoArgs?.method) throw new ForbiddenError();
        this.session.sudo = Date.now();
        if (this.session.sudoArgs.method.toLowerCase() === 'get') {
            this.response.redirect = this.session.sudoArgs.redirect;
            this.session.sudoArgs.method = null;
        } else this.back();
    }

    async post() {
        if (!this.session.sudoArgs?.method) throw new ForbiddenError();
        this.session.sudo = Date.now();
        if (this.session.sudoArgs.method.toLowerCase() !== 'get') {
            this.response.template = 'user_sudo_redirect.html';
            this.response.body = this.session.sudoArgs;
        } else this.response.redirect = this.session.sudoArgs.redirect;
        this.session.sudoArgs.method = null;
    }
}

class UserTFAHandler extends Handler {
    noCheckPermView = true;

    @param('q', Types.String)
    async get({ }, q: string) {
        let udoc = await user.getByUname('system', q);
        udoc ||= await user.getByEmail('system', q);
        if (!udoc) this.response.body = { tfa: false, authn: false };
        else this.response.body = { tfa: udoc.tfa, authn: udoc.authn };
    }
}

class UserWebauthnHandler extends Handler {
    noCheckPermView = true;

    getAuthnHost() {
        return system.get('authn.host') && this.request.hostname.includes(system.get('authn.host'))
            ? system.get('authn.host') : this.request.hostname;
    }

    @param('uname', Types.Username, true)
    @param('login', Types.Boolean)
    async get(domainId: string, uname: string, login: boolean) {
        let allowCredentials = [];
        let uid = 0;
        if (!login) {
            const udoc = this.user._id ? this.user : ((await user.getByEmail(domainId, uname)) || await user.getByUname(domainId, uname));
            if (!udoc._id) throw new UserNotFoundError(uname || 'user');
            if (!udoc.authn) throw new AuthOperationError('authn', 'disabled');
            allowCredentials = udoc._authenticators.map((authenticator) => ({
                id: isoBase64URL.fromBuffer(new Uint8Array(authenticator.credentialID.buffer)),
            }));
            uid = udoc._id;
        }
        const options = await generateAuthenticationOptions({
            allowCredentials,
            rpID: this.getAuthnHost(),
            userVerification: 'preferred',
        });
        await token.add(token.TYPE_WEBAUTHN, 60, { uid: login ? 'login' : uid }, options.challenge);
        this.session.challenge = options.challenge;
        this.response.body.authOptions = options;
    }

    async post({ domainId, result, redirect }) {
        const challenge = this.session.challenge;
        if (!challenge) throw new ForbiddenError('no-challenge');
        const tdoc = await token.get(challenge, token.TYPE_WEBAUTHN);
        if (!tdoc) throw new InvalidTokenError(token.TYPE_TEXTS[token.TYPE_WEBAUTHN]);
        const udoc = await (tdoc.uid === 'login'
            ? (async () => {
                const u = await user.coll.findOne({ 'authenticators.credentialID': Binary.createFromBase64(result.id) });
                return u ? await user.getById(domainId, u._id) : null;
            })()
            : user.getById(domainId, tdoc.uid));
        if (!udoc) throw new NotFoundError();
        const parseId = (id: Binary) => Buffer.from(id.toString('hex'), 'hex').toString('base64url');
        const authenticator = udoc._authenticators?.find((c) => parseId(c.credentialID) === result.id);
        if (!authenticator) throw new ValidationError('authenticator');
        const verification = await verifyAuthenticationResponse({
            response: result,
            expectedChallenge: challenge,
            expectedOrigin: this.request.headers.origin,
            expectedRPID: this.getAuthnHost(),
            credential: {
                ...authenticator,
                id: isoBase64URL.fromBuffer(new Uint8Array(authenticator.credentialID.buffer)),
                publicKey: new Uint8Array(authenticator.credentialPublicKey.buffer),
            },
        }).catch(() => null);
        if (!verification?.verified) throw new ValidationError('authenticator');
        authenticator.counter = verification.authenticationInfo.newCounter;
        await user.setById(udoc._id, { authenticators: udoc._authenticators });
        if (tdoc.uid === 'login') {
            await successfulAuth.call(this, await user.getById(domainId, udoc._id));
            await token.del(challenge, token.TYPE_WEBAUTHN);
            this.response.redirect = redirect || ((this.request.referer || '/login').endsWith('/login')
                ? this.url('homepage') : this.request.referer);
        } else {
            await token.update(challenge, token.TYPE_WEBAUTHN, 60, { verified: true });
            this.back();
        }
    }
}

class UserLogoutHandler extends Handler {
    noCheckPermView = true;

    async get() {
        this.response.template = 'user_logout.html';
    }

    async post({ domainId }) {
        await successfulAuth.call(this, await user.getById(domainId, 0));
        this.response.redirect = '/';
    }
}

// rename to RegisterSendMailHandler
export class UserRegisterHandler extends Handler {
    noCheckPermView = true;
    async prepare() {
        if (!system.get('server.login')) throw new BuiltinLoginError();
    }

    async get() {
        this.response.template = 'user_register.html';
    }

    @post('mail', Types.Email)
    async post({ }, mail: string) {
        if (await user.getByEmail('system', mail)) throw new UserAlreadyExistError(mail);
        const mailDomain = mail.split('@')[1];
        if (await BlackListModel.get(`mail::${mailDomain}`)) throw new BlacklistedError(mailDomain);
        await Promise.all([
            this.limitRate('send_mail', 60, 1, mail),
            this.limitRate('send_mail', 3600, 30),
            oplog.log(this, 'user.register', {}),
        ]);
        const t = await token.add(
            token.TYPE_REGISTRATION,
            system.get('session.unsaved_expire_seconds'),
            {
                mail,
                redirect: this.domain.registerRedirect,
                identity: {
                    provider: 'mail',
                    platform: 'mail',
                    id: mail,
                },
            },
        );
        const prefix = this.domain.host
            ? `${this.domain.host instanceof Array ? this.domain.host[0] : this.domain.host}`
            : system.get('server.url');
        if (system.get('smtp.verify') && system.get('smtp.user')) {
            const m = await this.renderHTML('user_register_mail.html', {
                path: `/register/${t[0]}`,
                url_prefix: prefix.endsWith('/') ? prefix.slice(0, -1) : prefix,
            });
            await sendMail(mail, 'Sign Up', 'user_register_mail', m.toString());
            this.response.template = 'user_register_mail_sent.html';
            this.response.body = { mail };
        } else this.response.redirect = this.url('user_register_with_code', { code: t[0] });
    }
}

class UserRegisterWithCodeHandler extends Handler {
    noCheckPermView = true;
    tdoc: TokenDoc;

    @param('code', Types.String)
    async prepare({ }, code: string) {
        this.tdoc = await token.get(code, token.TYPE_REGISTRATION);
        if (!this.tdoc?.identity) {
            // prevent brute forcing tokens
            await this.limitRate('user_register_with_code', 60, 5);
            throw new InvalidTokenError(token.TYPE_TEXTS[token.TYPE_REGISTRATION], code);
        }
    }

    async get() {
        const provider = this.ctx.oauth.providers[this.tdoc.identity.provider];
        this.response.template = 'user_register_with_code.html';
        this.response.body = {
            ...this.tdoc,
            lockUsername: !!provider?.lockUsername,
        };
    }

    @param('password', Types.Password)
    @param('verifyPassword', Types.Password)
    @param('uname', Types.Username, true)
    @param('code', Types.String)
    async post(
        domainId: string, password: string, verify: string,
        uname = '', code: string,
    ) {
        const provider = this.ctx.oauth.providers[this.tdoc.identity.provider];
        if (!provider) throw new SystemError(`OAuth provider ${this.tdoc.identity.provider} not found`);
        if (provider.lockUsername) uname = this.tdoc.username;
        if (!Types.Username[1](uname)) throw new ValidationError('uname');
        if (password !== verify) throw new VerifyPasswordError();
        const randomEmail = `${randomstring(12)}@invalid.local`; // some random email to remove in the future
        const uid = await user.create(this.tdoc.mail || randomEmail, uname, password, undefined, this.request.ip);
        await token.del(code, token.TYPE_REGISTRATION);
        const [id, mailDomain] = this.tdoc.mail.split('@');
        const $set: any = this.tdoc.set || {};
        if (mailDomain === 'qq.com' && !Number.isNaN(+id)) {
            $set.avatar = `qq:${id}`;
            $set.qq = `${id}`;
        }
        if (this.session.viewLang) $set.viewLang = this.session.viewLang;
        if (Object.keys($set).length) await user.setById(uid, $set);
        if (Object.keys(this.tdoc.setInDomain || {}).length) await domain.setUserInDomain(domainId, uid, this.tdoc.setInDomain);
        await this.ctx.oauth.set(this.tdoc.identity.platform, this.tdoc.identity.id, uid);
        await successfulAuth.call(this, await user.getById(domainId, uid));
        this.response.redirect = this.tdoc.redirect || this.url('home_settings', { category: 'preference' });
    }
}

class UserLostPassHandler extends Handler {
    noCheckPermView = true;

    async get() {
        if (!system.get('server.login')) throw new BuiltinLoginError();
        this.response.template = 'user_lostpass.html';
    }

    @param('mail', Types.Email)
    async post(domainId: string, mail: string) {
        if (!system.get('server.login')) throw new BuiltinLoginError();
        if (!system.get('smtp.user')) throw new SystemError('Cannot send mail');
        const udoc = await user.getByEmail('system', mail);
        if (!udoc) throw new UserNotFoundError(mail);
        await Promise.all([
            this.limitRate('send_mail', 3600, 30),
            this.limitRate('send_mail', 60, 1, mail),
            oplog.log(this, 'user.lostpass', {}),
        ]);
        const [tid] = await token.add(
            token.TYPE_LOSTPASS,
            system.get('session.unsaved_expire_seconds'),
            { uid: udoc._id },
        );
        const prefix = this.domain.host
            ? `${this.domain.host instanceof Array ? this.domain.host[0] : this.domain.host}`
            : system.get('server.url');
        const m = await this.renderHTML('user_lostpass_mail.html', {
            url: `/lostpass/${tid}`,
            url_prefix: prefix.endsWith('/') ? prefix.slice(0, -1) : prefix,
            uname: udoc.uname,
        });
        await sendMail(mail, 'Lost Password', 'user_lostpass_mail', m.toString());
        this.response.template = 'user_lostpass_mail_sent.html';
    }
}

class UserLostPassWithCodeHandler extends Handler {
    noCheckPermView = true;

    async get({ domainId, code }) {
        if (!system.get('server.login')) throw new BuiltinLoginError();
        const tdoc = await token.get(code, token.TYPE_LOSTPASS);
        if (!tdoc) throw new InvalidTokenError(token.TYPE_TEXTS[token.TYPE_LOSTPASS], code);
        const udoc = await user.getById(domainId, tdoc.uid);
        this.response.body = { uname: udoc.uname };
        this.response.template = 'user_lostpass_with_code.html';
    }

    @param('code', Types.String)
    @param('password', Types.Password)
    @param('verifyPassword', Types.Password)
    async post(domainId: string, code: string, password: string, verifyPassword: string) {
        if (!system.get('server.login')) throw new BuiltinLoginError();
        const tdoc = await token.get(code, token.TYPE_LOSTPASS);
        if (!tdoc) throw new InvalidTokenError(token.TYPE_TEXTS[token.TYPE_LOSTPASS], code);
        if (password !== verifyPassword) throw new VerifyPasswordError();
        await user.setById(tdoc.uid, { authenticators: [], tfa: false });
        await user.setPassword(tdoc.uid, password);
        await token.del(code, token.TYPE_LOSTPASS);
        this.response.redirect = this.url('homepage');
    }
}

class UserDetailHandler extends Handler {
    @param('uid', Types.Int)
    async get(domainId: string, uid: number) {
        if (uid === 0) throw new UserNotFoundError(0);
        const isSelfProfile = this.user._id === uid;
        const [udoc, sdoc] = await Promise.all([
            user.getById(domainId, uid),
            token.getMostRecentSessionByUid(uid, ['createAt', 'updateAt']),
        ]);
        if (!udoc) throw new UserNotFoundError(uid);
        const pdocs: ProblemDoc[] = [];
        const acInfo: Record<string, number> = {};
        const canViewHidden = this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || this.user._id;
        if (this.user.hasPerm(PERM.PERM_VIEW_PROBLEM)) {
            const psdocs = await problem.getMultiStatus(domainId, { uid, status: STATUS.STATUS_ACCEPTED }).toArray();
            pdocs.push(...Object.values(
                await problem.getList(
                    domainId, psdocs.map((i) => i.docId), canViewHidden,
                    false, problem.PROJECTION_LIST, true,
                ),
            ));
        }
        for (const pdoc of pdocs) {
            for (const tag of pdoc.tag) {
                if (acInfo[tag]) acInfo[tag]++;
                else acInfo[tag] = 1;
            }
        }
        const tags = Object.entries(acInfo).sort((a, b) => b[1] - a[1]).slice(0, 20);
        const tsdocs = await ContestModel.getMultiStatus(domainId, { uid, attend: { $exists: true } }).project({ docId: 1 }).toArray();
        const tdocs = await ContestModel.getMulti(domainId, { docId: { $in: tsdocs.map((i) => i.docId) } })
            .project({ docId: 1, title: 1, rule: 1 }).sort({ _id: -1 }).toArray();
        this.response.template = 'user_detail.html';
        this.response.body = {
            isSelfProfile, udoc, sdoc, pdocs, tags, tdocs,
        };
        if (this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_SOLUTION)) {
            const psdocs = await SolutionModel.getByUser(domainId, uid).limit(10).toArray();
            this.response.body.psdocs = psdocs;
            if (this.user.hasPerm(PERM.PERM_VIEW_PROBLEM)) {
                this.response.body.pdict = await problem.getList(
                    domainId, psdocs.map((i) => i.parentId), canViewHidden,
                    false, problem.PROJECTION_LIST,
                );
            }
        }
        this.UiContext.extraTitleContent = udoc.uname;
    }
}

class UserDeleteHandler extends Handler {
    async post({ password }) {
        await this.user.checkPassword(password);
        const tid = await ScheduleModel.add({
            executeAfter: moment().add(7, 'days').toDate(),
            type: 'script',
            id: 'deleteUser',
            args: { uid: this.user._id },
        });
        await user.setById(this.user._id, { del: tid });
        this.response.template = 'user_delete_pending.html';
    }
}

class OauthHandler extends Handler {
    noCheckPermView = true;

    @param('type', Types.Key)
    @param('redirect', Types.String, true)
    async get(domainId: string, type: string, redirect = '') {
        this.session.oauthRedirect = redirect;
        await this.ctx.oauth.providers[type]?.get.call(this);
    }
}

class OauthCallbackHandler extends Handler {
    noCheckPermView = true;

    async get(args: any) {
        const provider = this.ctx.oauth.providers[args.type];
        if (!provider) throw new UserFacingError('Oauth type');
        await this.limitRate('oauth_callback', 60, 5);
        const r = await provider.callback.call(this, args);
        const ids = Array.isArray(r._id) ? r._id : [r._id];
        const existing = await Promise.all(ids.map((id) => this.ctx.oauth.get(args.type, id)));
        if (this.session.oauthBind === args.type) {
            delete this.session.oauthBind;
            if (existing.some((id) => id && id !== this.user._id)) {
                throw new BadRequestError('Already bound to another account');
            }
            await Promise.all(ids.map((i) => this.ctx.oauth.set(args.type, i, this.user._id)));
            if (r.priv !== undefined) await user.setById(this.user._id, { priv: r.priv });
            const { noLocalPassword: _ignored3, ...update3 } = (r.set || {});
            if (Object.keys(update3).length) await user.setById(this.user._id, update3);
            this.response.redirect = this.session.oauthRedirect || this.url('home_security');
            delete this.session.oauthRedirect;
            return;
        }
        const effective = existing.find((i) => i);
        if (effective) {
            if (r.priv !== undefined) await user.setById(effective, { priv: r.priv });
            // 不覆盖 noLocalPassword，避免已设密码的用户被再次强制设密
            const { noLocalPassword: _ignored, ...update } = (r.set || {});
            if (Object.keys(update).length) await user.setById(effective, update);
            const eudoc = await user.getById('system', effective);
            await successfulAuth.call(this, eudoc);
            this.response.redirect = this.session.oauthRedirect || this.url('homepage');
            delete this.session.oauthRedirect;
            return;
        }
        const udoc = await user.getByEmail('system', r.email);
        if (udoc) {
            await Promise.all(ids.map((i) => this.ctx.oauth.set(args.type, i, udoc._id)));
            if (r.priv !== undefined) await user.setById(udoc._id, { priv: r.priv });
            const { noLocalPassword: _ignored2, ...update2 } = (r.set || {});
            if (Object.keys(update2).length) await user.setById(udoc._id, update2);
            const mudoc = await user.getById('system', udoc._id);
            await successfulAuth.call(this, mudoc);
            this.response.redirect = this.session.oauthRedirect || this.url('homepage');
            delete this.session.oauthRedirect;
            return;
        }
        if (!provider.canRegister) throw new ForbiddenError('No bound account found');
        // 受信 provider 可直接自动注册；普通 OAuth 注册仍受 PRIV_REGISTER_USER 控制。
        if (!provider.autoRegister) this.checkPriv(PRIV.PRIV_REGISTER_USER);
        if (provider.autoRegister) {
            // OAuth 自动注册：无需再填密码，直接建号并登录
            let username = '';
            r.uname ||= [];
            if (!r.uname.length) r.uname = [`${args.type}_${r._id}`];
            for (const uname of r.uname) {
                const nudoc = await user.getByUname('system', uname);
                if (!nudoc) {
                    username = uname;
                    break;
                }
            }
            if (!username) username = `${r.uname[0]}_${Date.now().toString(36)}`;
            const set: Partial<Udoc> = { ...r.set };
            if (r.bio) set.bio = r.bio;
            if (r.viewLang) set.viewLang = r.viewLang;
            if (r.avatar) set.avatar = r.avatar;
            const mail = r.email || `${randomstring(16)}@oauth.invalid`;
            let uid: number;
            const preferredUid = Number.isSafeInteger(r.uid) && r.uid >= 2 ? r.uid : undefined;
            try {
                uid = await user.create(mail, username, randomstring(32), preferredUid, this.request.ip, r.priv);
            } catch (err) {
                // 并发注册可能撞上唯一键，换一个稳定后缀并放弃指定 UID 重试一次。
                username = `${username}_${randomstring(6)}`.slice(0, 24);
                uid = await user.create(mail, username, randomstring(32), undefined, this.request.ip, r.priv);
            }
            if (Object.keys(set).length) await user.setById(uid, set);
            if (Object.keys(r.setInDomain || {}).length) {
                await domain.setUserInDomain(this.domain._id, uid, r.setInDomain);
            }
            await Promise.all(ids.map((i) => this.ctx.oauth.set(args.type, i, uid)));
            const nudoc = await user.getById('system', uid);
            await successfulAuth.call(this, nudoc);
            this.response.redirect = this.session.oauthRedirect || this.url('homepage');
            delete this.session.oauthRedirect;
            return;
        }
        let username = '';
        r.uname ||= [];
        const mailDomain = r.email.split('@')[1];
        if (await BlackListModel.get(`mail::${mailDomain}`)) throw new BlacklistedError(mailDomain);
        for (const uname of r.uname) {
            // eslint-disable-next-line no-await-in-loop
            const nudoc = await user.getByUname('system', uname);
            if (!nudoc) {
                username = uname;
                break;
            }
        }
        const set: Partial<Udoc> = { ...r.set };
        if (r.bio) set.bio = r.bio;
        if (r.viewLang) set.viewLang = r.viewLang;
        if (r.avatar) set.avatar = r.avatar;
        const [t] = await token.add(
            token.TYPE_REGISTRATION,
            system.get('session.unsaved_expire_seconds'),
            {
                mail: r.email,
                username,
                redirect: this.domain.registerRedirect,
                set,
                setInDomain: r.setInDomain,
                identity: {
                    provider: args.type,
                    platform: args.type,
                    id: r._id,
                },
            },
        );
        this.response.redirect = this.url('user_register_with_code', { code: t });
    }
}

class ContestModeHandler extends Handler {
    async get() {
        const bindings = await user.getMulti({ loginip: { $exists: true } })
            .project<{ _id: number, loginip: string }>({ _id: 1, loginip: 1 }).toArray();
        this.response.body = { bindings };
        this.response.template = 'contest_mode.html';
    }

    @param('uid', Types.Int, true)
    async postReset(domainId: string, uid: number) {
        if (uid) await user.setById(uid, {}, { loginip: '' });
        else {
            await user.coll.updateMany({}, { $unset: { loginip: 1 } });
            deleteUserCache(true);
        }
    }
}

export const inject = ['oauth'];

const UserApi = {
    user: Query(Schema.object({
        id: Schema.number().step(1),
        uname: Schema.string(),
        mail: Schema.string(),
        domainId: Schema.string().required(),
    }), (c, arg) => {
        if (arg.id) return user.getById(arg.domainId, arg.id);
        if (arg.mail) return user.getByEmail(arg.domainId, arg.mail);
        if (arg.uname) return user.getByUname(arg.domainId, arg.uname);
        return user.getById(arg.domainId, c.user._id);
    }),
    users: Query(Schema.object({
        ids: Schema.array(Schema.number().step(1)),
        auto: Schema.array(Schema.string()),
        search: Schema.string(),
        limit: Schema.number().step(1),
        exact: Schema.boolean(),
    }), async (c, arg) => {
        const auto = (arg.ids?.length && arg.ids) || arg.auto || [];
        if (auto.length) {
            const maybeId = auto.filter((i) => !Number.isNaN(+i));
            const result = [];
            if (maybeId.length) {
                const udocs = await user.getList(arg.domainId, maybeId.map((i) => +i));
                for (const i in udocs) udocs[i].avatarUrl = avatar(udocs[i].avatar);
                result.push(...Object.values(udocs));
            }
            const notFound = auto.filter((i) => !result.find((j) => j._id === +i));
            if (notFound.length > 50) return result; // reject if too many
            for (const i of notFound) {
                // eslint-disable-next-line no-await-in-loop
                const udoc = await user.getByUname(arg.domainId, i.toString()) || await user.getByEmail(arg.domainId, i.toString());
                if (udoc) result.push(udoc);
            }
            return result;
        }
        if (!arg.search) return [];
        const udoc = await user.getById(arg.domainId, +arg.search)
            || await user.getByUname(arg.domainId, arg.search)
            || await user.getByEmail(arg.domainId, arg.search);
        const udocs: User[] = arg.exact
            ? []
            : await user.getPrefixList(arg.domainId, arg.search, Math.min(arg.limit || 10, 10));
        if (udoc && !udocs.find((i) => i._id === udoc._id)) {
            udocs.pop();
            udocs.unshift(udoc);
        }
        for (const i in udocs) {
            udocs[i].avatarUrl = avatar(udocs[i].avatar);
        }
        return udocs;
    }),
} as const;

declare module '@hydrooj/framework' {
    interface Apis {
        user: typeof UserApi;
    }
}

export async function apply(ctx: Context) {
    ctx.Route('user_login', '/login', UserLoginHandler);
    ctx.Route('user_oauth', '/oauth/:type/login', OauthHandler);
    ctx.Route('user_sudo', '/user/sudo', UserSudoHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('user_tfa', '/user/tfa', UserTFAHandler);
    ctx.Route('user_webauthn', '/user/webauthn', UserWebauthnHandler);
    ctx.Route('user_oauth_callback', '/oauth/:type/callback', OauthCallbackHandler);
    ctx.Route('user_register', '/register', UserRegisterHandler, PRIV.PRIV_REGISTER_USER);
    ctx.Route('user_register_with_code', '/register/:code', UserRegisterWithCodeHandler, PRIV.PRIV_REGISTER_USER);
    ctx.Route('user_logout', '/logout', UserLogoutHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('user_lostpass', '/lostpass', UserLostPassHandler);
    ctx.Route('user_lostpass_with_code', '/lostpass/:code', UserLostPassWithCodeHandler);
    ctx.Route('user_delete', '/user/delete', UserDeleteHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('user_detail', '/user/:uid', UserDetailHandler);
    if (system.get('server.contestmode')) {
        ctx.Route('contest_mode', '/contestmode', ContestModeHandler, PRIV.PRIV_EDIT_SYSTEM);
    }
    ctx.oauth.provide('mail', {
        text: 'Mail',
        name: 'mail',
        hidden: true,
        async get() {
            throw new NotFoundError();
        },
        async callback() {
            throw new NotFoundError();
        },
    });
    await ctx.inject(['api'], ({ api }) => {
        api.provide(UserApi);
    });
}
