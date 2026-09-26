/**
 * 签到：用户每日签到入库，管理员查看谁签到 / 谁未签到。
 */
import {
    Context, Handler, PRIV, Schema, Service,
} from 'hydrooj';
import moment from 'moment-timezone';

const collName = 'checkin';

export function dayKey(date: Date | number = new Date()) {
    return moment(date).tz('Asia/Shanghai').format('YYYY-MM-DD');
}

class CheckinService extends Service {
    static inject = ['db'];
    static Config = Schema.object({});

    public coll: any;

    constructor(ctx: Context) {
        super(ctx, 'checkin');
        currentService = this;
    }

    async [Service.init]() {
        this.coll = (this.ctx.db as any).collection(collName);
        await (this.ctx.db as any).ensureIndexes(this.coll, {
            name: 'user_day',
            key: { domainId: 1, uid: 1, day: 1 },
            unique: true,
        });
    }

    async isCheckedIn(domainId: string, uid: number, day = dayKey()) {
        return !!(await this.coll.findOne({ domainId, uid, day }));
    }

    async checkIn(domainId: string, uid: number, uname: string) {
        const day = dayKey();
        const existing = await this.coll.findOne({ domainId, uid, day });
        if (existing) return { ok: true, day, already: true };
        await this.coll.insertOne({ domainId, uid, uname, day, createdAt: new Date() });
        return { ok: true, day, already: false };
    }

    async listDay(domainId: string, day: string) {
        return await this.coll.find({ domainId, day }).sort({ createdAt: 1 }).toArray();
    }

    async listUser(domainId: string, uid: number, limit = 30) {
        return await this.coll.find({ domainId, uid }).sort({ day: -1 }).limit(limit).toArray();
    }
}

// Cordis 禁止未 inject 时读 ctx.checkin，这里用模块内单例。
let currentService: CheckinService | null = null;
function svc(): CheckinService {
    if (!currentService) throw new Error('checkin service not ready');
    return currentService;
}

function domainOf(handler: Handler): string {
    return (handler as any).domainId || (handler as any).domain?._id || 'system';
}

class CheckinHandler extends Handler {
    async get() {
        if (!this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            this.response.redirect = this.url('user_login');
            return;
        }
        const domainId = domainOf(this);
        const day = dayKey();
        const checked = await svc().isCheckedIn(domainId, this.user._id, day);
        const history = await svc().listUser(domainId, this.user._id, 45);
        const todayList = await svc().listDay(domainId, day);
        this.response.template = 'checkin.html';
        this.response.body = {
            day,
            checked,
            history,
            records: history.map((r: any) => r.day),
            todayCount: todayList.length,
        };
    }

    async post() {
        if (!this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            this.response.redirect = this.url('user_login');
            return;
        }
        const result = await svc().checkIn(domainOf(this), this.user._id, this.user.uname);
        if (this.request.json) {
            this.response.body = result;
            return;
        }
        this.response.redirect = this.url('checkin');
    }
}

class CheckinManageHandler extends Handler {
    async get({ day }: { day?: string }) {
        if (!this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
            this.response.body = { error: 'Permission denied' };
            return;
        }
        const domainId = domainOf(this);
        const target = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : dayKey();
        const records = await svc().listDay(domainId, target);
        const checkedUids = new Set(records.map((r: any) => r.uid));
        const udocs = await (this.ctx.db as any).collection('user').find({}).sort({ uname: 1 }).toArray();
        const rows = udocs
            .filter((u: any) => u._id !== 0)
            .map((u: any) => ({
                uid: u._id,
                uname: u.uname,
                displayName: u.displayName || '',
                checked: checkedUids.has(u._id),
                at: records.find((r: any) => r.uid === u._id)?.createdAt || null,
            }));
        this.response.template = 'checkin_manage.html';
        this.response.body = {
            day: target,
            rows,
            checkedCount: rows.filter((r) => r.checked).length,
            total: rows.length,
        };
    }
}

export async function apply(ctx: Context) {
    await ctx.plugin(CheckinService);
    ctx.Route('checkin', '/checkin', CheckinHandler);
    ctx.Route('checkin_manage', '/checkin/manage', CheckinManageHandler);

    // 入口在用户名下拉菜单（UserDropdown），与「我的资料」等同级，样式保持 Hydro 原生 menu__link
    ctx.i18n.load('zh', {
        checkin: '签到',
        Checkin: '签到',
        'Check-in records': '签到记录',
        'Checked in': '已签到',
        'Not checked in': '未签到',
        'Check in': '签到',
    });
    ctx.i18n.load('zh_TW', {
        checkin: '簽到',
        Checkin: '簽到',
        'Check-in records': '簽到記錄',
        'Checked in': '已簽到',
        'Not checked in': '未簽到',
        'Check in': '簽到',
    });
    ctx.i18n.load('en', {
        checkin: 'Check-in',
        Checkin: 'Check-in',
        'Check-in records': 'Check-in records',
        'Checked in': 'Checked in',
        'Not checked in': 'Not checked in',
        'Check in': 'Check in',
    });
    ctx.i18n.load('ko', {
        checkin: '출석',
        Checkin: '출석',
        'Check-in records': '출석 기록',
        'Checked in': '출석함',
        'Not checked in': '미출석',
        'Check in': '출석하기',
    });
}

export default CheckinService;
