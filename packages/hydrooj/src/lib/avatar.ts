import { Types } from '@hydrooj/framework/validator';
import { md5 } from '../utils';

type AvatarProvider = (src: string, size: number) => string;

export const providers: Record<string, AvatarProvider> = {
    // Gravatar 在国内常不可用，统一回落本地图
    gravatar: () => '/img/avatar.png',
    qq: (id) => `//q1.qlogo.cn/g?b=qq&nk=${(/(\d+)/.exec(id) || ['', ''])[1]}&s=160`,
    github: (id, size) => `//github.com/${id}.png?size=${Math.min(size, 460)}`,
    url: (url) => url,
};

function avatar(src: string, size = 64, fallback = '') {
    src ||= fallback;
    let index = src.indexOf(':');
    if (index === -1 && fallback) {
        src = fallback;
        index = src.indexOf(':');
    }
    // 空头像不走 Gravatar，避免外网图床加载失败
    if (index === -1) return '/img/avatar.png';
    const [provider, str] = [src.substring(0, index), src.substring(index + 1, src.length)];
    if (!providers[provider] || !str) return '/img/avatar.png';
    return providers[provider](str, size);
}

/** 强制使用 QQ 头像：avatar 字段为空或 gravatar 时，用 QQ 号映射 qlogo。 */
export function qqAvatar(udoc: { avatar?: string; qq?: string | number }, size = 64): string {
    const av = (udoc && udoc.avatar) || '';
    // 已有有效自定义头像（qq:/url:/github:）则保留
    if (/^(qq|url|github):/.test(av)) return avatar(av, size);
    // 无头像或 gravatar 回落时，用 QQ 号
    const qq = udoc && udoc.qq;
    if (qq && /^[1-9]\d{4,}$/.test(String(qq))) return avatar(`qq:${qq}`, size);
    return avatar(av, size);
}

export function validate(input: string) {
    if (!input) return true;
    if (input.startsWith('url:')) return true;
    if (input.startsWith('github:')) return /^[a-zA-Z0-9-]+$/.test(input.substring(7, input.length));
    if (input.startsWith('qq:')) return /^[1-9]\d{4,}$/.test(input.substring(3));
    if (input.startsWith('gravatar:')) return Types.Email[1](input.substring(9));
    return false;
}

export default avatar;
