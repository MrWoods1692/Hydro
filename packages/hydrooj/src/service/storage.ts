import { dirname, resolve } from 'path';
import { PassThrough, Readable } from 'stream';
import { URL } from 'url';
import { Agent } from 'undici';
import {
    DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand,
    HeadObjectCommand, PutObjectCommand, PutObjectCommandInput, S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
    copyFile, createReadStream, createWriteStream, ensureDir,
    existsSync, remove, stat, writeFile,
} from 'fs-extra';
import proxy from 'koa-proxies';
import { lookup } from 'mime-types';
import { nanoid } from 'nanoid';
import Schema from 'schemastery';
import { Context } from '../context';
import { Logger } from '../logger';
import { MaybeArray } from '../typeutils';
import { md5, streamToBuffer } from '../utils';

const logger = new Logger('storage');

function parseAlternativeEndpointUrl(endpoint: string): (originalUrl: string) => string {
    if (!endpoint) return (originalUrl) => originalUrl;
    const pathonly = endpoint.startsWith('/');
    if (pathonly) endpoint = `https://localhost${endpoint}`;
    const url = new URL(endpoint);
    if (url.hash || url.search) throw new Error('Search parameters and hash are not supported for alternative endpoint URL.');
    if (!url.pathname.endsWith('/')) throw new Error("Alternative endpoint URL's pathname must ends with '/'.");
    return (originalUrl) => {
        const parsedOriginUrl = new URL(originalUrl);
        const replaced = new URL(parsedOriginUrl.pathname.slice(1) + parsedOriginUrl.search + parsedOriginUrl.hash, url).toString();
        return pathonly
            ? replaced.replace('https://localhost', '')
            : replaced;
    };
}
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/encodeURIComponent
export function encodeRFC5987ValueChars(str: string) {
    return (
        encodeURIComponent(str)
            // Note that although RFC3986 reserves "!", RFC5987 does not,
            // so we do not need to escape it
            .replace(/['()]/g, escape) // i.e., %27 %28 %29
            .replace(/\*/g, '%2A')
            // The following are not required for percent-encoding per RFC5987,
            // so we can allow for a little better readability over the wire: |`^
            .replace(/%(?:7C|60|5E)/g, unescape)
    );
}

const convertPath = (p: string) => {
    p = p.trim();
    if (p.includes('..') || p.includes('//') || p.endsWith('/.') || p === '.' || p.includes('/./')) {
        throw new Error('Invalid path');
    }
    return p;
};

const defaultPath = process.env.CI ? '/tmp/file'
    : process.env.DEFAULT_STORE_PATH || '/data/file/hydro';
const FileSetting = Schema.intersect([
    Schema.object({
        type: Schema.union([
            Schema.const('file').i18n({ en: 'Local Directory', zh: '本地目录' }),
            Schema.const('s3').description('S3'),
            Schema.const('webdav').description('WebDAV'),
        Schema.const('storage_to').description('storage.to'),
        ] as const).i18n({ en: 'Storage Provider Type', zh: '存储提供商类型' }),
        endPointForUser: Schema.string().default('/fs/'),
        endPointForJudge: Schema.string().default('/fs/'),
    }).i18n({ en: 'File Storage Setting', zh: '文件存储设置' }),
    Schema.union([
        Schema.object({
            type: Schema.const('file'),
            path: Schema.string().default(defaultPath).i18n({ en: 'Storage path', zh: '存储路径' }),
            secret: Schema.string().default(nanoid()).i18n({ en: 'Download file sign secret', zh: '下载文件签名密钥' }),
        }),
        Schema.object({
            type: Schema.const('s3').required(),
            endPoint: Schema.string(),
            accessKey: Schema.string(),
            secretKey: Schema.string().role('secret'),
            bucket: Schema.string().default('hydro'),
            region: Schema.string().default('us-east-1'),
            pathStyle: Schema.boolean().default(true),
        }),
        Schema.object({
            type: Schema.const('webdav').required(),
            endPoint: Schema.string().description('WebDAV server URL, e.g. https://example.com/dav'),
            username: Schema.string(),
            password: Schema.string().role('secret'),
            secret: Schema.string().default(nanoid()).i18n({ en: 'Download file sign secret', zh: '下载文件签名密钥' }),
        }),
        Schema.object({
            type: Schema.const('storage_to').required(),
            token: Schema.string().role('secret').description('storage.to API token'),
            secret: Schema.string().default(nanoid()).i18n({ en: 'Download file sign secret', zh: '下载文件签名密钥' }),
        }),
    ] as const),
] as const);

export const Config = FileSetting;

class RemoteStorageService {
    public client: S3Client;
    public error = '';
    public bucket = 'hydro';
    private replaceWithAlternativeUrlFor: Partial<Record<'user' | 'judge', (originalUrl: string) => string>>;
    private alternatives: Record<'user' | 'judge', S3Client> = {
        user: null,
        judge: null,
    };

    constructor(private config: ReturnType<typeof FileSetting>) {
    }

    async start() {
        try {
            logger.info('Starting storage service with endpoint:', this.config.endPoint);
            const {
                endPoint,
                accessKey,
                secretKey,
                bucket,
                region,
                pathStyle,
                endPointForUser,
                endPointForJudge,
            } = this.config;
            this.bucket = bucket;
            const base = {
                region,
                forcePathStyle: pathStyle,
                credentials: {
                    accessKeyId: accessKey,
                    secretAccessKey: secretKey,
                },
            };
            this.client = new S3Client({
                endpoint: endPoint,
                ...base,
            });
            this.replaceWithAlternativeUrlFor = {};
            if (/^https?:\/\//.test(endPointForUser)) {
                this.alternatives.user = new S3Client({
                    endpoint: endPointForUser,
                    ...base,
                });
            } else {
                this.replaceWithAlternativeUrlFor.user = parseAlternativeEndpointUrl(endPointForUser);
            }
            if (/^https?:\/\//.test(endPointForJudge)) {
                this.alternatives.judge = new S3Client({
                    endpoint: endPointForJudge,
                    ...base,
                });
            } else {
                this.replaceWithAlternativeUrlFor.judge = parseAlternativeEndpointUrl(endPointForJudge);
            }
            logger.success('Storage connected.');
            this.error = null;
        } catch (e) {
            logger.warn('Storage init fail. will retry later.');
            if (process.env.DEV) logger.warn(e);
            this.error = e.toString();
            setTimeout(() => this.start(), 10000);
        }
    }

    async put(target: string, file: string | Buffer | Readable, meta: Record<string, string> = {}) {
        target = convertPath(target);
        if (typeof file === 'string') file = createReadStream(file);
        const params: PutObjectCommandInput = {
            Bucket: this.bucket,
            Key: target,
            Body: file,
            Metadata: meta,
            ContentType: meta['Content-Type'] || 'application/octet-stream',
        };
        if (file instanceof Buffer && file.byteLength <= 5 * 1024 * 1024) {
            await this.client.send(new PutObjectCommand(params));
        } else {
            const upload = new Upload({
                client: this.client,
                params,
                tags: [],
                queueSize: 4,
                partSize: 1024 * 1024 * 5,
                leavePartsOnError: false,
            });
            await upload.done();
        }
    }

    async get(target: string, path?: string) {
        target = convertPath(target);
        const res = await this.client.send(new GetObjectCommand({
            Bucket: this.bucket,
            Key: target,
        }));
        if (!res.Body) throw new Error();
        const stream = res.Body as Readable;
        if (path) {
            await new Promise((end, reject) => {
                const file = createWriteStream(path);
                stream.on('error', reject);
                stream.on('end', () => {
                    file.close();
                    end(null);
                });
                stream.pipe(file);
            });
            return null;
        }
        const p = new PassThrough();
        stream.pipe(p);
        return p;
    }

    async del(target: string | string[]) {
        if (typeof target === 'string') target = convertPath(target);
        else target = target.map(convertPath);
        if (typeof target === 'string') {
            return await this.client.send(new DeleteObjectCommand({
                Bucket: this.bucket,
                Key: target,
            }));
        }
        return await this.client.send(new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: {
                Objects: target.map((i) => ({ Key: i })),
            },
        }));
    }

    async getMeta(target: string) {
        target = convertPath(target);
        const res = await this.client.send(new HeadObjectCommand({
            Bucket: this.bucket,
            Key: target,
        }));
        return {
            size: res.ContentLength,
            lastModified: res.LastModified,
            etag: res.ETag,
            metaData: res.Metadata,
        };
    }

    async signDownloadLink(target: string, filename?: string, noExpire = false, useAlternativeEndpointFor?: 'user' | 'judge'): Promise<string> {
        target = convertPath(target);
        const client = this.alternatives[useAlternativeEndpointFor] || this.client;
        const url = await getSignedUrl(client, new GetObjectCommand({
            Bucket: this.bucket,
            Key: target,
            ResponseContentDisposition: filename ? `attachment; filename="${encodeRFC5987ValueChars(filename)}"` : '',
        }), {
            // aliyun s3 will reject download if expires >= 7 days
            expiresIn: noExpire ? 24 * 60 * 60 * 7 - 1 : 30 * 60,
        });
        // using something like /fs/
        if (useAlternativeEndpointFor && this.replaceWithAlternativeUrlFor[useAlternativeEndpointFor]) {
            return this.replaceWithAlternativeUrlFor[useAlternativeEndpointFor](url);
        }
        return url;
    }

    async isLinkValid(_: string) {
        return false;
    }

    async signUpload(target: string, size: number) {
        const client = this.alternatives.user || this.client;
        const { url, fields } = await createPresignedPost(client, {
            Bucket: this.bucket,
            Key: target,
            Conditions: [
                { $key: target },
                { acl: 'public-read' },
                { bucket: this.bucket },
                ['content-length-range', size - 50, size + 50],
            ],
            Fields: {
                acl: 'public-read',
            },
            Expires: 600,
        });
        if (this.replaceWithAlternativeUrlFor.user) {
            return {
                url: this.replaceWithAlternativeUrlFor.user(url),
                fields,
            };
        }
        return { url, fields };
    }

    async status() {
        return {
            type: 'S3',
            status: !this.error,
            error: this.error,
            bucket: this.bucket,
        };
    }
}

class LocalStorageService {
    client: null;
    error = '';
    dir: string;
    opts: null;
    private replaceWithAlternativeUrlFor: Record<'user' | 'judge', (originalUrl: string) => string>;

    constructor(private config: ReturnType<typeof FileSetting>) {
    }

    async start() {
        logger.debug('Loading local storage service with path:', this.config.path);
        await ensureDir(this.config.path);
        this.dir = this.config.path;
        this.replaceWithAlternativeUrlFor = {
            user: parseAlternativeEndpointUrl(this.config.endPointForUser),
            judge: parseAlternativeEndpointUrl(this.config.endPointForJudge),
        };
    }

    async put(target: string, file: string | Buffer | Readable) {
        target = resolve(this.dir, convertPath(target));
        await ensureDir(dirname(target));
        if (typeof file === 'string') await copyFile(file, target);
        else if (Buffer.isBuffer(file)) await writeFile(target, file);
        else await writeFile(target, await streamToBuffer(file));
    }

    async get(target: string, path?: string) {
        target = resolve(this.dir, convertPath(target));
        if (!existsSync(target)) throw new Error(`File not found: ${target}`);
        if (path) await copyFile(target, path);
        return createReadStream(target);
    }

    async del(target: MaybeArray<string>) {
        const targets = (typeof target === 'string' ? [target] : target).map(convertPath);
        await Promise.all(targets.map((i) => remove(resolve(this.dir, i))));
    }

    async getMeta(target: string) {
        target = resolve(this.dir, convertPath(target));
        const file = await stat(target);
        return {
            size: file.size,
            etag: Buffer.from(target).toString('base64'),
            lastModified: file.mtime,
            metaData: {
                'Content-Type': (target.endsWith('.ans') || target.endsWith('.out'))
                    ? 'text/plain'
                    : lookup(target) || 'application/octet-stream',
                'Content-Length': file.size,
            },
        };
    }

    async signDownloadLink(target: string, filename = '', noExpire = false, useAlternativeEndpointFor?: 'user' | 'judge'): Promise<string> {
        target = convertPath(target);
        const url = new URL('https://localhost/storage');
        url.searchParams.set('target', target);
        if (filename) url.searchParams.set('filename', filename);
        const expire = (Date.now() + (noExpire ? 7 * 24 * 3600 : 600) * 1000).toString();
        url.searchParams.set('expire', expire);
        url.searchParams.set('secret', md5(`${target}/${expire}/${this.config.secret}`));
        if (useAlternativeEndpointFor) return this.replaceWithAlternativeUrlFor[useAlternativeEndpointFor](url.toString());
        return `/${url.toString().split('localhost/')[1]}`;
    }

    async isLinkValid(link: string) {
        const parts = link.split('/');
        const secret = parts.pop();
        parts.push(this.config.secret);
        const expected = md5(parts.join('/'));
        return expected === secret;
    }

    async signUpload() {
        throw new Error('Not implemented');
    }

    async status() {
        return {
            type: 'Local',
            status: !this.error,
            error: this.error,
            bucket: 'Hydro',
            dir: this.config.path,
        };
    }
}

let service;

/**
 * WebDAV storage backend.
 * Credentials are held only on the server side; downloads are proxied
 * through the signed /storage route so browsers never need the password.
 */
class WebDavStorageService {
    error = '';
    private authHeader = '';
    private base = '';
    private replaceWithAlternativeUrlFor: Record<'user' | 'judge', (originalUrl: string) => string>;
    private static readonly CHUNK_SIZE = 900 * 1024; // 900KB per chunk (WebDAV limit ~1MB)
    private static readonly META_SUFFIX = '.chunks.json';
    private static readonly dispatcher = new Agent({
        connect: { rejectUnauthorized: false },
    });

    constructor(private config: ReturnType<typeof FileSetting>) {
    }

    private async wfetch(url: string, init?: RequestInit): Promise<Response> {
        return fetch(url, { ...init, dispatcher: WebDavStorageService.dispatcher } as any);
    }

    private resourceUrl(target: string) {
        const base = this.base.endsWith('/') ? this.base : `${this.base}/`;
        return `${base}${target.split('/').map(encodeURIComponent).join('/')}`;
    }

    private async streamToBuffer(stream: Readable): Promise<Buffer> {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
    }

    private async putSingle(target: string, data: Buffer, meta: Record<string, string> = {}) {
        const headers: Record<string, string> = {
            Authorization: this.authHeader,
            'Content-Type': meta['Content-Type'] || 'application/octet-stream',
        };
        const body = new Uint8Array(data);
        const res = await this.wfetch(this.resourceUrl(target), { method: 'PUT', headers, body });
        if (!res.ok && res.status !== 201) throw new Error(`WebDAV PUT failed: HTTP ${res.status}`);
        await res.arrayBuffer();
    }

    private async deleteResource(target: string) {
        const res = await this.wfetch(this.resourceUrl(target), {
            method: 'DELETE',
            headers: { Authorization: this.authHeader },
        });
        if (!res.ok && res.status !== 404) throw new Error(`WebDAV DELETE failed: HTTP ${res.status}`);
        await res.arrayBuffer();
    }

    async start() {
        try {
            this.base = this.config.endPoint.replace(/\/+$/, '');
            this.authHeader = `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}`;
            const res = await this.wfetch(`${this.base}/`, {
                method: 'PROPFIND',
                headers: { Depth: '1', Authorization: this.authHeader },
            });
            if (!res.ok) throw new Error(`WebDAV connectivity check failed: HTTP ${res.status}`);
            await res.arrayBuffer();
            logger.success('WebDAV storage connected.');
            this.error = '';
        } catch (e) {
            logger.warn('WebDAV storage init fail. will retry later.');
            if (process.env.DEV) logger.warn(e);
            this.error = e.toString();
            setTimeout(() => this.start(), 10000);
        }
        this.replaceWithAlternativeUrlFor = {
            user: parseAlternativeEndpointUrl(this.config.endPointForUser),
            judge: parseAlternativeEndpointUrl(this.config.endPointForJudge),
        };
    }

    async put(target: string, file: string | Buffer | Readable, meta: Record<string, string> = {}) {
        target = convertPath(target);
        const dir = dirname(target);
        if (dir && dir !== '.') await this.ensureDir(dir);

        const body = typeof file === 'string' ? createReadStream(file) : file;
        const content = Buffer.isBuffer(body) ? body : await this.streamToBuffer(body as Readable);

        if (content.length <= WebDavStorageService.CHUNK_SIZE) {
            // Single chunk - direct upload
            await this.putSingle(target, content, meta);
            return;
        }

        // Chunked upload
        const chunks = Math.ceil(content.length / WebDavStorageService.CHUNK_SIZE);
        const metaInfo = { totalChunks: chunks, chunkSize: WebDavStorageService.CHUNK_SIZE, totalSize: content.length, meta };

        logger.info(`Uploading ${target}: ${chunks} chunks, ${content.length} bytes`);
        for (let i = 0; i < chunks; i++) {
            const chunk = content.slice(i * WebDavStorageService.CHUNK_SIZE, (i + 1) * WebDavStorageService.CHUNK_SIZE);
            await this.putSingle(`${target}.chunk${i}`, chunk, { 'Content-Type': 'application/octet-stream' });
        }
        await this.putSingle(`${target}${WebDavStorageService.META_SUFFIX}`, Buffer.from(JSON.stringify(metaInfo)), { 'Content-Type': 'application/json' });
    }

    async get(target: string, path?: string) {
        target = convertPath(target);

        // Check if chunked file
        const metaRes = await this.wfetch(this.resourceUrl(`${target}${WebDavStorageService.META_SUFFIX}`), {
            method: 'GET',
            headers: { Authorization: this.authHeader },
        });
        if (metaRes.ok) {
            const info = JSON.parse(await metaRes.text());
            logger.info(`Merging ${info.totalChunks} chunks for ${target}`);
            let merged = Buffer.alloc(info.totalSize);
            for (let i = 0; i < info.totalChunks; i++) {
                const chunkRes = await this.wfetch(this.resourceUrl(`${target}.chunk${i}`), {
                    method: 'GET',
                    headers: { Authorization: this.authHeader },
                });
                if (!chunkRes.ok) throw new Error(`WebDAV GET chunk ${i} failed: HTTP ${chunkRes.status}`);
                const chunkBuffer = Buffer.from(await chunkRes.arrayBuffer());
                chunkBuffer.copy(merged, i * info.chunkSize);
            }
            if (path) {
                await writeFile(path, merged);
                return null;
            }
            const p = new PassThrough();
            p.end(merged);
            return p;
        }

        // Single file
        const res = await this.wfetch(this.resourceUrl(target), {
            method: 'GET',
            headers: { Authorization: this.authHeader },
        });
        if (!res.ok) throw new Error(`WebDAV GET failed: HTTP ${res.status}`);
        if (!res.body) throw new Error('WebDAV GET returned empty body');
        const stream = Readable.fromWeb(res.body as never);
        if (path) {
            await new Promise((end, reject) => {
                const writer = createWriteStream(path);
                stream.on('error', reject);
                stream.on('end', () => {
                    writer.close();
                    end(null);
                });
                stream.pipe(writer);
            });
            return null;
        }
        const p = new PassThrough();
        stream.pipe(p);
        return p;
    }

    async del(target: MaybeArray<string>) {
        const targets = (typeof target === 'string' ? [target] : target).map(convertPath);
        await Promise.all(targets.map(async (t) => {
            // Check if chunked
            const metaRes = await this.wfetch(this.resourceUrl(`${t}${WebDavStorageService.META_SUFFIX}`), {
                method: 'GET',
                headers: { Authorization: this.authHeader },
            });
            if (metaRes.ok) {
                const info = JSON.parse(await metaRes.text());
                for (let i = 0; i < info.totalChunks; i++) {
                    await this.deleteResource(`${t}.chunk${i}`);
                }
                await this.deleteResource(`${t}${WebDavStorageService.META_SUFFIX}`);
            }
            await this.deleteResource(t);
        }));
    }

    async getMeta(target: string) {
        target = convertPath(target);

        // Check if chunked file
        const metaRes = await this.wfetch(this.resourceUrl(`${target}${WebDavStorageService.META_SUFFIX}`), {
            method: 'GET',
            headers: { Authorization: this.authHeader },
        });
        if (metaRes.ok) {
            const info = JSON.parse(await metaRes.text());
            return {
                size: info.totalSize,
                etag: Buffer.from(target).toString('base64'),
                lastModified: new Date(),
                metaData: info.meta || {
                    'Content-Type': (target.endsWith('.ans') || target.endsWith('.out')) ? 'text/plain' : lookup(target) || 'application/octet-stream',
                    'Content-Length': info.totalSize,
                },
            };
        }

        // Single file
        const res = await this.wfetch(this.resourceUrl(target), {
            method: 'PROPFIND',
            headers: {
                Depth: '0',
                Authorization: this.authHeader,
                'Content-Type': 'application/xml',
            },
            body: '<?xml version="1.0" encoding="UTF-8"?><D:propfind xmlns:D="DAV:"><D:prop>'
                + '<D:getcontentlength/><D:getlastmodified/><D:etag/></D:prop></D:propfind>',
        });
        if (!res.ok) throw new Error(`WebDAV PROPFIND failed: HTTP ${res.status}`);
        const xml = await res.text();
        const num = (re: RegExp) => {
            const m = xml.match(re);
            return m ? Number(m[1]) : 0;
        };
        const size = num(/getcontentlength[^>]*>(\d+)/i) || num(/getcontentlength>\s*(\d+)/i);
        const lm = xml.match(/getlastmodified[^>]*>([^<]+)</i);
        const etag = xml.match(/<D:etag[^>]*>([^<]+)<\/D:etag>/i);
        return {
            size,
            etag: etag?.[1] || Buffer.from(target).toString('base64'),
            lastModified: lm ? new Date(lm[1]) : new Date(),
            metaData: {
                'Content-Type': (target.endsWith('.ans') || target.endsWith('.out'))
                    ? 'text/plain'
                    : lookup(target) || 'application/octet-stream',
                'Content-Length': size,
            },
        };
    }

    private async ensureDir(dir: string) {
        const parts = dir.split('/').filter(Boolean);
        let current = '';
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            const res = await this.wfetch(this.resourceUrl(`${current}/`), {
                method: 'MKCOL',
                headers: { Authorization: this.authHeader },
            });
            if (res.status !== 201 && res.status !== 405 && res.status !== 409) {
                logger.warn(`WebDAV MKCOL ${current}: HTTP ${res.status}`);
            }
            await res.arrayBuffer();
        }
    }

    async signDownloadLink(target: string, filename = '', noExpire = false, useAlternativeEndpointFor?: 'user' | 'judge'): Promise<string> {
        target = convertPath(target);
        const url = new URL('https://localhost/storage');
        url.searchParams.set('target', target);
        if (filename) url.searchParams.set('filename', filename);
        const expire = (Date.now() + (noExpire ? 7 * 24 * 3600 : 600) * 1000).toString();
        url.searchParams.set('expire', expire);
        url.searchParams.set('secret', md5(`${target}/${expire}/${this.config.secret}`));
        return `/${url.toString().split('localhost/')[1]}`;
    }

    async isLinkValid(link: string) {
        const parts = link.split('/');
        const secret = parts.pop();
        parts.push(this.config.secret);
        const expected = md5(parts.join('/'));
        return expected === secret;
    }

    async signUpload() {
        throw new Error('Not implemented');
    }

    async status() {
        return {
            type: 'WebDAV',
            status: !this.error,
            error: this.error,
            bucket: this.base,
        };
    }
}

class StorageToStorageService {
    error = '';
    private token = '';
    private apiBase = 'https://storage.to/api';
    private replaceWithAlternativeUrlFor: Record<'user' | 'judge', (originalUrl: string) => string>;
    private static readonly dispatcher = new Agent({
        connect: { rejectUnauthorized: false },
    });
    private files: Map<string, { url: string; raw_url?: string }> = new Map();

    constructor(private config: ReturnType<typeof FileSetting>) {
    }

    async start() {
        this.token = this.config.token;
        logger.success('storage.to service ready.');
        this.error = '';
    }

    private async api(path: string, init?: RequestInit) {
        return fetch(`${this.apiBase}${path}`, {
            ...init,
            headers: {
                Authorization: `Bearer ${this.token}`,
                'Content-Type': 'application/json',
                ...init?.headers,
            },
            dispatcher: StorageToStorageService.dispatcher,
        } as any);
    }

    async put(target: string, file: string | Buffer | Readable, meta: Record<string, string> = {}): Promise<string> {
        target = convertPath(target);
        const filename = meta.filename || target.split('/').pop() || 'file';
        const contentType = meta['Content-Type'] || lookup(filename) || 'application/octet-stream';

        let buf: Buffer;
        if (typeof file === 'string') {
            buf = await streamToBuffer(createReadStream(file));
        } else if (file instanceof Buffer) {
            buf = file;
        } else {
            buf = await streamToBuffer(file);
        }

        const size = buf.byteLength;

        // Step 1: Init
        const initRes = await this.api('/upload/init', {
            method: 'POST',
            body: JSON.stringify({ filename, content_type: contentType, size }),
        });
        const initData = await initRes.json();
        if (!initData.success) throw new Error(`storage.to init failed: ${JSON.stringify(initData)}`);

        const uploadUrl = initData.upload_url;
        const r2Key = initData.r2_key;

        // Step 2: PUT to R2
        const r2Headers = initData.headers || {};
        const r2HeadersObj: Record<string, string> = {};
        for (const [k, v] of Object.entries(r2Headers)) {
            if (Array.isArray(v)) r2HeadersObj[k] = v[0];
        }
        const putRes = await fetch(uploadUrl, {
            method: 'PUT',
            body: buf as unknown as ReadableStream,
            headers: r2HeadersObj,
            dispatcher: StorageToStorageService.dispatcher,
        } as any);
        if (!putRes.ok) throw new Error(`storage.to upload to R2 failed: ${putRes.status} ${await putRes.text()}`);

        // Step 3: Confirm
        const confirmRes = await this.api('/upload/confirm', {
            method: 'POST',
            body: JSON.stringify({ r2_key: r2Key, filename, content_type: contentType, size }),
        });
        const confirmData = await confirmRes.json();
        if (!confirmData.success) throw new Error(`storage.to confirm failed: ${JSON.stringify(confirmData)}`);

        const fileUrl = confirmData.file.url;
        this.files.set(target, { url: fileUrl });
        logger.info(`Uploaded ${target} -> ${fileUrl}`);
        return fileUrl;
    }

    async get(target: string, options?: { stream?: Readable, buffer?: boolean }): Promise<string | Readable> {
        target = convertPath(target);
        const entry = this.files.get(target);
        if (!entry) {
            logger.warn(`storage.to file not found: ${target}`);
            return `https://storage.to/${target}`;
        }
        if (options?.buffer) {
            const res = await fetch(entry.url, {
                dispatcher: StorageToStorageService.dispatcher,
            } as any);
            const buf = Buffer.from(await res.arrayBuffer());
            return buf as any;
        }
        if (options?.stream) {
            const res = await fetch(entry.url, {
                dispatcher: StorageToStorageService.dispatcher,
            } as any);
            return Readable.fromWeb(res.body as any);
        }
        return entry.url;
    }

    async sign(target: string, options?: { filename?: string, noExpire?: boolean }): Promise<string> {
        target = convertPath(target);
        const entry = this.files.get(target);
        if (entry) return entry.url;
        return `https://storage.to/${target}`;
    }

    async isLinkValid(link: string) {
        return true;
    }

    async signUpload() {
        throw new Error('Not implemented for storage.to');
    }

    async status() {
        return {
            type: 'storage.to',
            status: !this.error,
            error: this.error,
            bucket: 'storage.to',
        };
    }
}

export async function apply(ctx: Context, config: ReturnType<typeof FileSetting>) {
    console.log('[storage.apply] config.type =', config.type, 'config =', JSON.stringify(config));
    if (config.type === 's3') {
        service = new RemoteStorageService(config);
    } else if (config.type === 'webdav') {
        service = new WebDavStorageService(config);
    } else if (config.type === 'storage_to') {
        service = new StorageToStorageService(config);
    } else {
        service = new LocalStorageService(config);
    }
    await service.start();
    await ctx.inject(['server'], ({ server }) => {
        let endpoint = config.endPoint;
        if (config.type === 's3' && !config.pathStyle) {
            try {
                const parsed = new URL(config.endPoint);
                parsed.hostname = `${config.bucket}.${parsed.hostname}`;
                endpoint = parsed.toString();
            } catch (e) {
                logger.warn('Failed to parse file endpoint');
            }
        }
        const proxyMiddleware = proxy('/fs', {
            target: endpoint,
            changeOrigin: true,
            rewrite: (p) => p.replace('/fs', ''),
        });
        server.addCaptureRoute('/fs/', async (c, next) => {
            if (c.request.search.toLowerCase().includes('x-amz-credential')) {
                c.nolog = true;
                return await proxyMiddleware(c, next);
            }
            c.request.path = c.path = c.path.split('/fs')[1];
            return await next();
        });
    });
    ctx.provide('storage', service);
}

declare module 'cordis' {
    interface Context {
        storage: RemoteStorageService | LocalStorageService | WebDavStorageService | StorageToStorageService;
    }
}

/** @deprecated use ctx.storage instead */
const serviceProxy = new Proxy({}, {
    get(self, key) {
        return service[key];
    },
}) as RemoteStorageService | LocalStorageService | WebDavStorageService | StorageToStorageService;
export default serviceProxy;
