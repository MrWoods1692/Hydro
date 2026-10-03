import {
    Context, Handler, Logger, PERM, PRIV, Schema, Service, superagent, SystemModel,
    TokenModel, UserFacingError, UserModel,
} from 'hydrooj';
import { pkceChallenge, randomVerifier } from './pkce';

const logger = new Logger('oauth.campux');

/** 支持逗号/中文逗号/空白分隔的多个管理员 QQ。 */
function parseAdminQqs(raw: string | undefined): string[] {
    return String(raw || '')
        .split(/[,\uFF0C\s]+/)
        .map((x) => x.trim())
        .filter((x) => /^\d{5,20}$/.test(x));
}

function requestOrigin(handler: Handler): string {
    const protoHeader = String(handler.request.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
    const proto = protoHeader || (handler.request.headers?.['x-forwarded-ssl'] ? 'https' : 'http');
    const host = String(handler.request.host || '').trim();
    if (host) return `${proto}://${host}`;
    return String(SystemModel.get('server.url') || 'http://127.0.0.1:8888/').replace(/\/+$/, '');
}

/**
 * OAuth 协议用的 redirect_uri（需在 Campux 应用登记 **一条** 即可）。
 * 优先 CAMPUX_OAUTH_CALLBACK，否则用实际请求的 origin 构建绝对 URL。
 * 用户从任意 host 打开时，登录完成后再用 attach 票据把会话桥接到当前 host。
 */
function resolveRedirectUri(handler: Handler): string {
    const fromEnv = String(process.env.CAMPUX_OAUTH_CALLBACK || '').trim();
    if (fromEnv) return fromEnv;
    let base = requestOrigin(handler).replace(/\/+$/, '');
    base += '/';
    return `${base}oauth/campux/callback`;
}

// Campux 官方标识（精简内联版，完整资源见 /img/campux-logo.svg）
const icon = '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="#0072D3" d="M32 6C16.5 6 8 18 8 34v18h14V33c0-8 4-14 12-14s12 6 12 14v19h14V34C60 18 47.5 6 32 6z"/><path fill="#0190E7" d="M22 52h28v6H22z"/><circle cx="32" cy="33" r="5" fill="#27D6FE"/></svg>';

type CampuxUserInfo = {
    sub: string;
    name: string;
    username: string;
    tenant_id?: string;
    tenant_name?: string;
    tenant_slug?: string;
    scope?: string;
    client_id?: string;
};


class CampuxAttachHandler extends Handler {
    noCheckPermView = true;

    async get({ ticket }: { ticket: string }) {
        if (!ticket) throw new UserFacingError('token');
        const t = await TokenModel.get(ticket, TokenModel.TYPE_EXPORT);
        if (!t || typeof t.uid !== 'number') throw new UserFacingError('token');
        await TokenModel.del(ticket, TokenModel.TYPE_EXPORT);
        const udoc = await UserModel.getById('system', t.uid);
        if (!udoc) throw new UserFacingError('token');
        this.context.HydroContext.user = udoc;
        this.session.uid = udoc._id;
        this.session.viewLang = '';
        this.session.sudo = null;
        this.session.sudoUid = null;
        this.session.scope = PERM.PERM_ALL.toString();
        this.session.recreate = true;
        this.response.redirect = typeof t.returnTo === 'string' && t.returnTo.startsWith('/') ? t.returnTo : '/';
    }
}

export default class LoginWithCampuxService extends Service {
    static inject = ['oauth', 'db', 'model:system'];
    static Config = Schema.object({
        endpoint: Schema.string().description('Campux 站点地址，如 https://kg.campux.top').required(),
        id: Schema.string().description('Campux OAuth Client ID').required(),
        secret: Schema.string().description('Campux OAuth Client Secret').role('secret').required(),
        scope: Schema.string().description('OAuth scope').default('profile'),
        canRegister: Schema.boolean().default(true).description('未绑定时自动注册'),
        autoRegister: Schema.boolean().default(true).description('自动注册时不再要求设置密码'),
        disablePasswordLogin: Schema.boolean().default(true).description('关闭内置账号密码登录，仅保留 Campux OAuth'),
        adminQq: Schema.string().default('1692138502,2671016745').description('自动设为系统管理员的 QQ 号，逗号分隔可多个'),
    });

    constructor(ctx: Context, private config: ReturnType<typeof LoginWithCampuxService.Config>) {
        super(ctx, 'oauth.campux');
        const endpoint = config.endpoint.replace(/\/+$/, '');

        ctx.oauth.provide('campux', {
            text: 'Login with Campux',
            name: 'Campux',
            icon,
            canRegister: config.canRegister,
            autoRegister: config.autoRegister,
            lockUsername: false,
            callback: async function callback(this: Handler, {
                state, code, error, error_description: errorDescription,
            }) {
                if (error) throw new UserFacingError(error, errorDescription);
                const s = await TokenModel.get(state, TokenModel.TYPE_OAUTH);
                if (!s) throw new UserFacingError('token');
                delete this.session.oauthCampuxState;
                // token 交换必须与 authorize 使用完全相同的 redirect_uri
                const redirectUri = String(s.redirectUri || resolveRedirectUri(this));
                const verifier = s.codeVerifier as string | undefined;
                if (!verifier) throw new UserFacingError('PKCE verifier missing');

                const tokenRes = await superagent.post(`${endpoint}/oauth/token`)
                    .type('form')
                    .send({
                        grant_type: 'authorization_code',
                        code,
                        redirect_uri: redirectUri,
                        client_id: config.id,
                        client_secret: config.secret,
                        code_verifier: verifier,
                    });
                if (tokenRes.body?.error) {
                    throw new UserFacingError(
                        tokenRes.body.error,
                        tokenRes.body.error_description || 'Campux token exchange failed',
                    );
                }
                const accessToken = tokenRes.body.access_token;
                if (typeof accessToken !== 'string' || !accessToken) {
                    throw new UserFacingError('Campux token exchange returned no access_token');
                }
                const infoRes = await superagent.get(`${endpoint}/oauth/userinfo`)
                    .set('Authorization', `Bearer ${accessToken}`)
                    .set('Accept', 'application/json');
                await TokenModel.del(s._id, TokenModel.TYPE_OAUTH);
                const info = infoRes.body as Partial<CampuxUserInfo>;
                const sub = typeof info?.sub === 'string' ? info.sub.trim() : '';
                if (!sub) throw new UserFacingError('Campux userinfo is missing sub');
                // Campux 文档约定 name 为 QQ 号；仍做格式校验，避免误把显示名当管理员标识。
                const qq = typeof info.name === 'string' ? info.name.trim() : '';
                if (!qq || !/^\d{5,20}$/.test(qq)) {
                    throw new UserFacingError('Campux userinfo.name must be the QQ number');
                }
                const displayName = typeof info.username === 'string' && info.username.trim()
                    ? info.username.trim() : qq;
                const email = `${qq}@campux.hydro.local`;
                const avatar = `qq:${qq}`;
                // Hydro 用户名：3–31 字符，或恰好 2 个汉字
                const isUname = (s: string) => /^(?:.{3,31}|[\u4E00-\u9FA5]{2})$/.test(s);
                // QQ 昵称优先作用户名；UID 使用 QQ 号
                const qqUid = Number(qq);
                return {
                    _id: sub,
                    email,
                    avatar,
                    uid: Number.isSafeInteger(qqUid) && qqUid >= 2 ? qqUid : undefined,
                    uname: [displayName, qq, `campux_${sub}`].filter((s) => s && isUname(s)),
                    ...(parseAdminQqs(config.adminQq).includes(qq) && /^\d+$/.test(qq) ? { priv: PRIV.PRIV_ALL } : {}),
                    set: {
                        qq,
                        avatar,
                        campuxUserId: sub,
                        campuxTenantId: typeof info.tenant_id === 'string' ? info.tenant_id : null,
                        campuxTenantName: typeof info.tenant_name === 'string' ? info.tenant_name : null,
                    },
                };
            },
            get: async function get(this: Handler) {
                const redirectUri = resolveRedirectUri(this);
                logger.info('Campux OAuth redirect_uri=%s', redirectUri);
                const verifier = randomVerifier();
                const challenge = pkceChallenge(verifier);
                const returnOrigin = requestOrigin(this);
                const [state] = await TokenModel.add(TokenModel.TYPE_OAUTH, 600, {
                    redirect: this.request.referer,
                    codeVerifier: verifier,
                    redirectUri,
                    returnOrigin,
                });
                this.session.oauthCampuxState = state;
                this.session.oauthCampuxReturn = returnOrigin;
                this.session.oauthCampuxReturnTo = this.session.oauthRedirect || '/';
                const authorize = new URL(`${endpoint}/oauth/authorize`);
                authorize.searchParams.set('response_type', 'code');
                authorize.searchParams.set('client_id', config.id);
                authorize.searchParams.set('redirect_uri', redirectUri);
                authorize.searchParams.set('scope', config.scope || 'profile');
                authorize.searchParams.set('state', state);
                authorize.searchParams.set('code_challenge', challenge);
                authorize.searchParams.set('code_challenge_method', 'S256');
                this.response.redirect = authorize.toString();
            },
        });

        // 即使站点还加载了其他 OAuth 插件，登录页也只暴露 Campux。
        ctx.on('handler/create/http', (handler: Handler) => {
            if (Array.isArray(handler.loginMethods)) {
                handler.loginMethods = handler.loginMethods.filter((method) => method.id === 'campux');
            }
        });
        ctx.on('app/started', () => {
            // 不仅隐藏按钮，也移除其它 provider，阻止直接访问 /oauth/<provider>/login。
            for (const provider of Object.keys(ctx.oauth.providers)) {
                if (provider !== 'campux') delete ctx.oauth.providers[provider];
            }
        });

        ctx.i18n.load('en', {
            'Login with Campux': 'Continue with Campux',
        });
        ctx.i18n.load('zh', {
            'Login with Campux': '使用 Campux 校园墙登录',
        });
        ctx.i18n.load('zh_TW', {
            'Login with Campux': '使用 Campux 校園牆登入',
        });
        ctx.i18n.load('ko', {
            'Login with Campux': 'Campux로 계속하기',
        });
        // 跨 host：OAuth 在统一 callback 上完成登录后，用一次性票据把会话桥接回用户实际访问的 host。
        ctx.on('auth/login', async (handler: any, udoc: any) => {
            try {
                const ret = String(handler.session?.oauthCampuxReturn || '').replace(/\/+$/, '');
                const current = requestOrigin(handler);
                if (!ret || ret === current || !udoc || udoc._id === 0) return;
                const [ticket] = await TokenModel.add(TokenModel.TYPE_EXPORT, 120, {
                    uid: udoc._id,
                    returnTo: handler.session.oauthCampuxReturnTo || '/',
                });
                handler.session.oauthRedirect = `${ret}/oauth/campux/attach?ticket=${encodeURIComponent(ticket)}`;
            } catch (e) {
                logger.warn('campux attach redirect failed: %o', e);
            }
        });

        ctx.Route('campux_attach', '/oauth/campux/attach', CampuxAttachHandler);

        logger.info('Campux OAuth enabled (password login: %s)', config.disablePasswordLogin ? 'disabled' : 'kept');
    }

    async [Service.init]() {
        const config = this.config as ReturnType<typeof LoginWithCampuxService.Config>;
        if (config.disablePasswordLogin) await SystemModel.set('server.login', false);

        // 兼容接入前已存在的账号：按 qq / 用户名 / 稳定假邮箱找到目标并设为管理员。
        const adminQqs = parseAdminQqs(config.adminQq);
        if (!adminQqs.length) return;
        for (const adminQq of adminQqs) {
            const existing = await UserModel.coll.findOne({
                $or: [
                    { qq: adminQq },
                    { uname: adminQq },
                    { mail: `${adminQq}@campux.hydro.local` },
                ],
            });
            if (existing) await UserModel.setPriv(existing._id, PRIV.PRIV_ALL);
        }
    }
}
