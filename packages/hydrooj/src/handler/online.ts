import type { Context } from '../context';
import avatar from '../lib/avatar';
import user from '../model/user';
import { Handler } from '../service/server';

// 在线用户名单接口：返回 opcount 中 5 分钟窗口内活跃的登录用户（uid/uname/头像 URL）。
class OnlineUsersHandler extends Handler {
    noCheckPermView = true;

    async get() {
        const docs = await this.ctx.db.collection('opcount')
            .find({ op: 'user_online' })
            .project({ ident: 1, _id: 0 })
            .toArray();
        const uids = [...new Set(docs.map((d) => Number(d.ident)))]
            .filter((n) => Number.isSafeInteger(n) && n > 1);
        const udict = await user.getList('system', uids);
        this.response.body = {
            online: uids.map((uid) => {
                const u = udict[uid];
                return u
                    ? { uid, uname: u.uname, avatar: avatar(u.avatar, 64) }
                    : { uid };
            }),
        };
    }
}

export function apply(ctx: Context) {
    ctx.Route('online_users', '/online', OnlineUsersHandler);
}