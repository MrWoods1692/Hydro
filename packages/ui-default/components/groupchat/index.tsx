import React, { useState, useRef, useEffect } from 'react';
import Notification from 'vj/components/notification';
import { request } from 'vj/utils';

const GROUPS = [
  { id: 'chat', name: '交流群', desc: '技术讨论与学习交流', icon: '💬' },
  { id: 'water', name: '水群', desc: '闲聊灌水', icon: '💧' },
];

// 配色：灰度主题
const C = {
  app: '#FFFFFF',
  sideBg: '#F5F5F4',
  sideItemHover: '#EDECEA',
  msgBg: '#F1EFEF',
  bubbleOther: '#FFFFFF',
  bubbleSelf: '#6A6560',
  bubbleSelfText: '#FFFFFF',
  text: '#3A3A38',
  text2: '#6A6560',
  text3: '#9A9690',
  border: '#E8E6E2',
  inputBg: '#F5F5F4',
};

// 灰度渐变头像背景
const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #8A8580 0%, #6A6560 100%)',
  'linear-gradient(135deg, #A09A95 0%, #7A7570 100%)',
  'linear-gradient(135deg, #7A7570 0%, #5A5550 100%)',
];
function avatarBg(uid) {
  return AVATAR_GRADIENTS[Math.abs(Number(uid) || 0) % AVATAR_GRADIENTS.length];
}

// 消息头像组件：有头像用图，否则显示首字母
function Avatar({ url, uname, uid, size = 40 }) {
  if (url) {
    return (
      <img
        src={url}
        width={size}
        height={size}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', background: '#E8E6E2', flexShrink: 0 }}
      />
    );
  }
  const ch = (uname || uid || '?').toString().charAt(0).toUpperCase();
  return (
    <div
      style={{
        width: size, height: size, borderRadius: '50%', background: avatarBg(uid),
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#FFFFFF', fontSize: size * 0.4, fontWeight: 600, flexShrink: 0,
      }}
    >
      {ch}
    </div>
  );
}

// 日期分隔标签
function DateSeparator({ dateStr }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '16px 0 8px' }}>
      <div style={{ background: 'rgba(154,150,144,0.16)', color: C.text3, fontSize: '12px', padding: '3px 12px', borderRadius: '10px' }}>
        {dateStr}
      </div>
    </div>
  );
}

export default function App({ WebSocket }) {
  const [activeGroup, setActiveGroup] = useState(null);
  const [messages, setMessages] = useState({});
  const [muted, setMuted] = useState({});
  const [isAdmin, setIsAdmin] = useState({});
  const [memberCount, setMemberCount] = useState({});
  const [input, setInput] = useState({});
  const [loading, setLoading] = useState({});
  const [isPosting, setIsPosting] = useState(false);
  const [showMutedList, setShowMutedList] = useState(false);
  const [mutedUsers, setMutedUsers] = useState({});
  const [mobileOpen, setMobileOpen] = useState(false);
  const contentRef = useRef({});
  const inputRef = useRef({});

  const currentUid = (typeof UserContext !== 'undefined' ? UserContext._id : null);
  const currentAvatar = (typeof UserContext !== 'undefined' ? UserContext.avatarUrl : null);

  const isMobile = () => {
    try {
      if (typeof window.matchMedia !== 'function') return false;
      return !!(window.matchMedia('(max-width: 767px)').matches);
    } catch (e) {
      return false;
    }
  };

  // 按 _id 去重追加消息：HTTP 响应和 WebSocket 广播会重复推送同一条消息
  function appendMessage(list, mdoc) {
    const arr = list || [];
    if (mdoc._id && arr.some((m) => m._id && m._id.toString() === mdoc._id.toString())) {
      return arr;
    }
    return [...arr, mdoc];
  }

  function loadGroup(groupId) {
    if (messages[groupId]) return;
    setLoading((prev) => ({ ...prev, [groupId]: true }));
    request.get(`/group?group=${groupId}`, { _: Date.now() })
      .then((data) => {
        setMessages((prev) => ({ ...prev, [groupId]: data.messages || [] }));
        setMuted((prev) => ({ ...prev, [groupId]: data.muted || false }));
        setIsAdmin((prev) => ({ ...prev, [groupId]: data.isAdmin || false }));
        setMemberCount((prev) => ({ ...prev, [groupId]: data.memberCount || 0 }));
        setMutedUsers((prev) => ({ ...prev, [groupId]: data.mutedList || [] }));
        setLoading((prev) => ({ ...prev, [groupId]: false }));
      })
      .catch(() => setLoading((prev) => ({ ...prev, [groupId]: false })));
  }

  function selectGroup(g) {
    setActiveGroup(g.id);
    loadGroup(g.id);
    setShowMutedList(false);
    if (isMobile()) setMobileOpen(true);
  }

  function scrollBottom() {
    const el = contentRef.current[activeGroup];
    if (el) el.scrollTop = el.scrollHeight;
  }

  useEffect(() => {
    if (activeGroup && messages[activeGroup]) {
      setTimeout(scrollBottom, 50);
    }
  }, [activeGroup, messages]);

  useEffect(() => {
    if (WebSocket) {
      WebSocket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.operation !== 'event' || !msg.payload) return;
        const mdoc = msg.payload.mdoc || msg.payload;
        if (!mdoc.group || !mdoc._id) return;
        const gid = mdoc.group;
        if (messages[gid] !== undefined) {
          setMessages((prev) => ({ ...prev, [gid]: appendMessage(prev[gid], mdoc) }));
        }
        if (gid === activeGroup) setTimeout(scrollBottom, 50);
      };
    }
  }, [WebSocket, activeGroup]);

  async function sendMessage() {
    const val = (input[activeGroup] || '').trim();
    if (!val || isPosting) return;
    setIsPosting(true);
    setInput((prev) => ({ ...prev, [activeGroup]: '' }));
    try {
      const res = await request.post('', {
        operation: 'send',
        group: activeGroup,
        content: val,
      });
      if (res.mdoc) {
        const gid = activeGroup as string;
        setMessages((prev) => ({ ...prev, [gid]: appendMessage(prev[gid], res.mdoc) }));
        setTimeout(scrollBottom, 50);
      }
    } catch (e: any) {
      Notification.error(e.message || '发送失败');
    } finally {
      setIsPosting(false);
    }
  }

  async function deleteMessage(msgId) {
    try {
      await request.post('', { operation: 'deleteMessage', messageId: msgId });
      const gid = activeGroup as string;
      setMessages((prev) => ({
        ...prev,
        [gid]: (prev[gid] || []).filter((m) => m._id.toString() !== msgId.toString()),
      }));
    } catch (e: any) {
      Notification.error(e.message || '删除失败');
    }
  }

  async function toggleMute(uid, uname) {
    try {
      const gid = activeGroup as string;
      if (muted[gid]) {
        await request.post('', { operation: 'unmuteUser', uid, group: gid });
      } else {
        await request.post('', { operation: 'muteUser', uid, group: gid });
      }
      Notification.info(`已${muted[gid] ? '解除' : '禁言'} ${uname}`);
      loadGroup(gid);
    } catch (e: any) {
      Notification.error(e.message || '操作失败');
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendMessage();
    }
  }

  function messageTs(id) {
    const ts = new Date();
    ts.setTime(parseInt(id.substring(0, 8), 16) * 1000);
    return ts;
  }
  function shortTime(id) {
    return messageTs(id).toLocaleString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  }
  function fullTime(id) {
    return messageTs(id).toLocaleString('zh-CN', {
      hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }
  function dayKey(id) {
    return messageTs(id).toLocaleDateString('zh-CN');
  }

  // 侧边栏
  function renderSidebar() {
    return (
      <div style={sidebarStyle}>
        <div style={sidebarHeadStyle}>
          <span style={{ fontSize: '16px', fontWeight: 700, color: C.text }}>群聊</span>
        </div>
        <ol style={{ listStyle: 'none', margin: 0, padding: '8px', overflow: 'auto' }}>
          {GROUPS.map((g) => {
            const active = g.id === activeGroup;
            return (
              <div
                key={g.id}
                onClick={() => selectGroup(g)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '12px',
                  padding: '10px 12px', borderRadius: '12px', cursor: 'pointer',
                  background: active ? C.sideItemHover : 'transparent',
                  transition: 'background 0.15s',
                  marginBottom: '2px',
                }}
              >
                <div style={{ width: '42px', height: '42px', borderRadius: '12px', background: C.sideItemHover, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '22px', flexShrink: 0 }}>
                  {g.icon}
                </div>
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <div style={{ fontSize: '14px', fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {g.name}
                  </div>
                  <div style={{ fontSize: '12px', color: C.text3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px' }}>
                    {g.desc}
                  </div>
                </div>
              </div>
            );
          })}
        </ol>
      </div>
    );
  }

  // 空状态
  function renderEmpty() {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: C.text3, gap: '10px' }}>
        <div style={{ fontSize: '48px', opacity: 0.4 }}>💬</div>
        <div style={{ fontSize: '14px' }}>选择一个群开始聊天</div>
      </div>
    );
  }

  // 主内容
  function renderContent() {
    if (!activeGroup) return renderEmpty();

    const group = GROUPS.find((g) => g.id === activeGroup);
    const msgList = messages[activeGroup] || [];
    const isAdmin_ = isAdmin[activeGroup];
    const muted_ = muted[activeGroup];
    const loading_ = loading[activeGroup];

    // 渲染消息：插入日期分隔符
    const rendered = [];
    let lastDay = '';
    msgList.forEach((msg) => {
      const dk = dayKey(msg._id);
      if (dk !== lastDay) {
        lastDay = dk;
        rendered.push(<DateSeparator key={`sep-${msg._id}`} dateStr={dk} />);
      }
      rendered.push(renderMessage(msg, isAdmin_));
    });

    return (
      <div style={contentStyle}>
        <div style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: '22px' }}>{group.icon}</span>
            <span style={{ fontSize: '16px', fontWeight: 700, color: C.text }}>{group.name}</span>
            <span style={{ fontSize: '12px', color: C.text3, background: C.sideItemHover, padding: '2px 9px', borderRadius: '10px' }}>
              {memberCount[activeGroup] || 0}人
            </span>
          </div>
          {isAdmin_ && (
            <button
              onClick={() => setShowMutedList(!showMutedList)}
              style={{
                padding: '7px 14px', border: '1px solid #E8E6E2', borderRadius: '9px',
                background: '#FAFAF8', cursor: 'pointer', fontSize: '13px', color: '#6A6560',
                display: 'flex', alignItems: 'center', gap: '5px',
              }}
            >
              <span style={{ fontSize: '14px' }}>🔇</span> 禁言管理
            </button>
          )}
        </div>

        {showMutedList && isAdmin_ && (
          <div style={mutedPanelStyle}>
            <div style={{ fontWeight: 700, marginBottom: '12px', color: C.text, fontSize: '14px' }}>已禁言用户</div>
            {(mutedUsers[activeGroup] || []).length === 0 && (
              <div style={{ color: C.text3, fontSize: '13px' }}>暂无禁言用户</div>
            )}
            {(mutedUsers[activeGroup] || []).map((u) => (
              <div key={u.uid} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0', borderBottom: '1px solid #F0EFEB' }}>
                <span style={{ flex: 1, fontSize: '14px', color: C.text }}>{u.uname || `UID ${u.uid}`}</span>
                <button
                  onClick={async () => {
                    try {
                      await request.post('', { operation: 'unmuteUser', uid: u.uid, group: activeGroup });
                      setMutedUsers((prev) => ({
                        ...prev,
                        [activeGroup]: (prev[activeGroup] || []).filter((x) => x.uid !== u.uid),
                      }));
                      Notification.info('已解除禁言');
                    } catch (e) {
                      Notification.error('操作失败');
                    }
                  }}
                  style={unmuteBtnStyle}
                >
                  解除
                </button>
              </div>
            ))}
            <button onClick={() => setShowMutedList(false)} style={{ ...muteBtnStyle, marginTop: '14px', padding: '7px 16px' }}>关闭</button>
          </div>
        )}

        <ol
          ref={(ref) => { contentRef.current[activeGroup] = ref; }}
          style={{ flex: 1, overflow: 'auto', listStyle: 'none', margin: 0, padding: '16px', background: C.msgBg }}
        >
          {loading_ ? (
            <div style={{ textAlign: 'center', padding: '40px', color: C.text3 }}>加载中...</div>
          ) : msgList.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: C.text3, fontSize: '14px' }}>
              <div style={{ fontSize: '36px', opacity: 0.4, marginBottom: '8px' }}>💬</div>
              还没有消息，来发第一条吧
            </div>
          ) : (
            rendered
          )}
        </ol>

        {muted_ ? (
          <div style={{ height: '72px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#FAFAF8', borderTop: `1px solid ${C.border}`, color: C.text3, fontSize: '14px' }}>
            🔇 你已被禁言，无法发送消息
          </div>
        ) : (
          <div style={inputBarStyle}>
            <div style={{ flex: 1, position: 'relative' }}>
              <textarea
                ref={(ref) => { inputRef.current[activeGroup] = ref; }}
                data-markdown
                disabled={isPosting}
                value={input[activeGroup] || ''}
                placeholder={`发送到 ${group.name}...`}
                onKeyDown={handleKeyDown}
                onChange={(e) => setInput((prev) => ({ ...prev, [activeGroup]: e.target.value }))}
                style={{
                  width: '100%', boxSizing: 'border-box', border: `1px solid ${C.border}`,
                  borderRadius: '16px', padding: '12px 16px', fontSize: '14px',
                  color: C.text, background: C.inputBg, resize: 'none',
                  fontFamily: 'inherit', lineHeight: 1.5,
                }}
                rows={1}
                onInput={(e) => {
                  e.target.style.height = 'auto';
                  e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
                }}
              />
            </div>
            <button
              disabled={!input[activeGroup]?.trim() || isPosting}
              onClick={sendMessage}
              style={sendBtnStyle(input[activeGroup]?.trim() && !isPosting)}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a.5.5 0 0 0-.7.46L2.7 10.5a1 1 0 0 0 .38 1.04L8 14.25l-4.92 2.71a1 1 0 0 0-.38 1.04l.02 6.43a.5.5 0 0 0 .7.46z" fill="currentColor" transform="rotate(-45 12 12)"/>
              </svg>
            </button>
          </div>
        )}
      </div>
    );
  }

  // 单条消息
  function renderMessage(msg, adminOn) {
    const isSelf = msg.from === currentUid;
    const fromUser = msg.fromUser || {};
    const uname = fromUser.uname || `UID ${msg.from}`;
    const avatarUrl = isSelf ? currentAvatar : fromUser.avatarUrl;
    const mutedOn = muted[activeGroup];

    const header = (
      <div style={{
        display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px',
        opacity: isSelf ? 0.75 : 1,
      }}>
        <span style={{
          fontWeight: 600, fontSize: '13px',
          color: isSelf ? 'rgba(255,255,255,0.9)' : C.text2,
        }}>
          {isSelf ? '我' : uname}
        </span>
        {adminOn && msg.from !== 1 && !isSelf && (
          <button onClick={() => toggleMute(msg.from, uname)} style={isSelf ? muteBtnSelfStyle : muteBtnStyle} title={mutedOn ? '解除禁言' : '禁言'}>
            {mutedOn ? '🔊 解除' : '🔇 禁言'}
          </button>
        )}
        {adminOn && (
          <button onClick={() => deleteMessage(msg._id)} style={delBtnSelfStyle} title="删除">
            🗑
          </button>
        )}
      </div>
    );

    const bubble = (
      <div style={{
        maxWidth: '72%',
        background: isSelf ? C.bubbleSelf : C.bubbleOther,
        color: isSelf ? C.bubbleSelfText : C.text,
        padding: '10px 14px',
        borderRadius: isSelf ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
        boxShadow: isSelf ? 'none' : '0 1px 2px rgba(0,0,0,0.04)',
        wordBreak: 'break-word',
        lineHeight: 1.5,
        fontSize: '14px',
      }}>
        {header}
        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.content}</div>
        <time style={{
          opacity: 0.55, fontSize: '11px', marginTop: '6px',
          display: 'inline-block', textAlign: 'right',
          color: isSelf ? 'rgba(255,255,255,0.7)' : C.text3,
        }}>
          {shortTime(msg._id)}
        </time>
      </div>
    );

    if (isSelf) {
      return (
        <div key={msg._id} style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '12px' }}>
          {bubble}
        </div>
      );
    }
    return (
      <div key={msg._id} style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'flex-start', gap: '10px', marginBottom: '12px' }}>
        <Avatar url={avatarUrl} uname={uname} uid={msg.from} />
        <div style={{ maxWidth: '78%', display: 'flex', flexDirection: 'column' }}>
          {bubble}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', width: '100%', height: 'calc(100vh - 140px)', minHeight: '480px', border: `1px solid ${C.border}`, borderRadius: '16px', overflow: 'hidden', background: C.app }}>
      <div style={{ position: 'relative', flexShrink: 0 }}>
        {renderSidebar()}
        {isMobile() && mobileOpen && (
          <div onClick={() => setMobileOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 90 }} />
        )}
      </div>
      {renderContent()}
    </div>
  );
}

const sidebarStyle = {
  width: '260px',
  background: C.sideBg,
  borderRight: `1px solid ${C.border}`,
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
};
const sidebarHeadStyle = {
  padding: '18px 18px 12px',
};
const headerStyle = {
  height: '56px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '0 20px',
  background: C.app,
  borderBottom: `1px solid ${C.border}`,
  flexShrink: 0,
};
const contentStyle = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  background: C.msgBg,
};
const inputBarStyle = {
  display: 'flex',
  gap: '10px',
  alignItems: 'flex-end',
  padding: '12px 16px',
  background: C.app,
  borderTop: `1px solid ${C.border}`,
  flexShrink: 0,
};

function sendBtnStyle(active) {
  return {
    width: '44px', height: '44px', borderRadius: '14px',
    border: 'none', cursor: active ? 'pointer' : 'not-allowed',
    background: active ? C.bubbleSelf : '#D8D5D0',
    color: '#FFFFFF',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'background 0.15s', flexShrink: 0,
  };
}

const muteBtnStyle = {
  border: `1px solid ${C.border}`,
  background: '#FFFFFF',
  color: C.text2,
  borderRadius: '7px',
  padding: '1px 7px',
  fontSize: '11px',
  cursor: 'pointer',
  lineHeight: '1.6',
};
const muteBtnSelfStyle = {
  ...muteBtnStyle,
  background: 'rgba(255,255,255,0.15)',
  color: '#FFFFFF',
  border: '1px solid rgba(255,255,255,0.25)',
};
const delBtnSelfStyle = {
  ...muteBtnStyle,
  background: 'rgba(181,155,155,0.12)',
  color: '#B59B9B',
  border: '1px solid #ECD5D5',
};
const unmuteBtnStyle = {
  ...muteBtnStyle,
  padding: '4px 12px',
  fontSize: '12px',
};

const mutedPanelStyle = {
  position: 'absolute',
  right: '20px',
  top: '68px',
  width: '300px',
  background: '#FFFFFF',
  border: `1px solid ${C.border}`,
  borderRadius: '14px',
  padding: '18px',
  boxShadow: '0 8px 28px rgba(0,0,0,0.12)',
  zIndex: 10,
};
