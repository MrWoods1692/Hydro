import { Filter, ObjectId } from 'mongodb';
import { MessageDoc } from '../interface';
import bus from '../service/bus';
import db from '../service/db';
import { ArgMethod } from '../utils';
import { PRIV } from './builtin';
import system from './system';
import user from './user';

class MessageModel {
    static FLAG_UNREAD = 1;
    static FLAG_ALERT = 2;
    static FLAG_RICHTEXT = 4;
    static FLAG_INFO = 8;
    static FLAG_I18N = 16;
    static FLAG_GROUP = 32;

    static coll = db.collection('message');
    static groupColl = db.collection('message_group' as any) as any;
    static muteColl = db.collection('message_mute' as any) as any;

    @ArgMethod
    static async send(
        from: number, to: number | number[],
        content: string, flag: number = MessageModel.FLAG_UNREAD,
    ) {
        if (!Array.isArray(to)) to = [to];
        const base = { from, content, flag, to };
        if (!to.length) return base;
        await MessageModel.coll.insertOne(base);
        bus.broadcast('user/message', to, base);
        if (flag & MessageModel.FLAG_UNREAD) await user.inc(to, 'unreadMsg', 1);
        return base;
    }

    static async sendInfo(to: number, content: string) {
        const mdoc: MessageDoc = {
            from: 1, to, content, flag: MessageModel.FLAG_INFO | MessageModel.FLAG_I18N,
        };
        bus.broadcast('user/message', [to], mdoc);
    }

    static async get(_id: ObjectId) {
        return await MessageModel.coll.findOne({ _id });
    }

    @ArgMethod
    static async getByUser(uid: number) {
        return await MessageModel.coll.find({ $or: [{ from: uid }, { to: uid }], group: null }).sort('_id', -1).limit(1000).toArray();
    }

    static async getMany(query: Filter<MessageDoc>, sort: any, page: number, limit: number) {
        return await MessageModel.coll.find(query).sort(sort)
            .skip((page - 1) * limit).limit(limit)
            .toArray();
    }

    static async del(_id: ObjectId) {
        return await MessageModel.coll.deleteOne({ _id });
    }

    @ArgMethod
    static count(query: Filter<MessageDoc> = {}) {
        return MessageModel.coll.countDocuments(query);
    }

    static getMulti(uid: number) {
        return MessageModel.coll.find({ $or: [{ from: uid }, { to: uid }] });
    }

    static async sendGroup(group: string, from: number, content: string, fromUser: any) {
        const mdoc: MessageDoc = {
            from, to: null, content, flag: MessageModel.FLAG_GROUP, group, fromUser,
        };
        await MessageModel.coll.insertOne(mdoc);
        // Notify all non-muted users in the group (excluding sender)
        const members = await MessageModel.groupColl.find({ _id: group, uid: { $ne: null } }).toArray();
        const uids = members.map((m: any) => m.uid).filter((u: number) => u !== from);
        bus.broadcast('user/message', uids, mdoc as any);
        return mdoc;
    }

    static async getGroupMessages(group: string, limit = 100, before?: ObjectId) {
        const query: any = { group };
        if (before) query._id = { $lt: before };
        return await MessageModel.coll.find(query).sort('_id', -1).limit(limit).toArray();
    }

    static async isMuted(group: string, uid: number) {
        return !!(await MessageModel.muteColl.findOne({ group, uid }));
    }

    static async muteUser(group: string, uid: number, by: number) {
        await MessageModel.muteColl.updateOne(
            { group, uid }, { $set: { group, uid, by, at: new Date() } }, { upsert: true },
        );
    }

    static async unmuteUser(group: string, uid: number) {
        await MessageModel.muteColl.deleteOne({ group, uid });
    }

    static async getMutedUsers(group: string) {
        return await MessageModel.muteColl.find({ group }).toArray();
    }

    static async getGroups() {
        return await MessageModel.groupColl.find({}).toArray();
    }

    static async getGroupMembers(group: string) {
        return await MessageModel.groupColl.find({ _id: group, uid: { $ne: null } }).project({ uid: 1 }).toArray();
    }

    static async addGroupMember(group: string, uid: number) {
        await MessageModel.groupColl.updateOne(
            { _id: group, uid }, { $setOnInsert: { _id: group, uid, joinedAt: new Date() } }, { upsert: true },
        );
    }

    static async delGroupMember(group: string, uid: number) {
        await MessageModel.groupColl.deleteOne({ _id: group, uid });
    }

    static async sendNotification(message: string, ...args: any[]) {
        const targets = await user.getMulti({ priv: { $bitsAllSet: PRIV.PRIV_VIEW_SYSTEM_NOTIFICATION } })
            .project({ _id: 1, viewLang: 1 }).toArray();
        return Promise.all(targets.map(({ _id, viewLang }) => {
            const msg = app.i18n.translate(message, [viewLang || system.get('server.language')]).format(...args);
            return MessageModel.send(1, _id, msg, MessageModel.FLAG_RICHTEXT);
        }));
    }
}

export async function apply() {
    await db.ensureIndexes(
        MessageModel.coll,
        { key: { to: 1, _id: -1 }, name: 'to' },
        { key: { from: 1, _id: -1 }, name: 'from' },
        { key: { group: 1, _id: -1 }, name: 'group' },
    );
    await db.ensureIndexes(MessageModel.groupColl, { key: { _id: 1, uid: 1 }, name: 'group_member', unique: true });
    await db.ensureIndexes(MessageModel.muteColl, { key: { group: 1, uid: 1 }, name: 'mute', unique: true });

    // Seed default groups if not exist
    const existing = await MessageModel.groupColl.countDocuments({});
    if (existing === 0) {
        await MessageModel.groupColl.insertMany([
            { _id: 'chat', name: '交流群', desc: '技术讨论与学习交流', createdAt: new Date() },
            { _id: 'water', name: '水群', desc: '闲聊灌水', createdAt: new Date() },
        ]);
    }
}
export default MessageModel;
global.Hydro.model.message = MessageModel;
