import React, { useState, useRef, useEffect, useCallback } from 'react';
import Notification from 'vj/components/notification';
import { request } from 'vj/utils';

const GROUPS = [
  { id: 'chat', name: '交流群', desc: '技术讨论与学习交流', icon: '💬' },
  { id: 'water', name: '水群', desc: '闲聊灌水', icon: '💧' },
];

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

  const isMobile = () => window.matchMedia && window.matchMedia('(max-width: 767px)').matches;

  function loadGroup(groupId) {
    if (messages[groupId]) return;
    setLoading(prev => ({ ...prev, [groupId]: true }));
    request.get(`/group?group=${groupId}`, { _: Date.now() })
      .then((data) => {
        setMessages(prev => ({ ...prev, [groupId]: data.messages || [] }));
        setMuted(prev => ({ ...prev, [groupId]: data.muted || false }));
        setIsAdmin(prev => ({ ...prev, [groupId]: data.isAdmin || false }));
        setMemberCount(prev => ({ ...prev, [groupId]: data.memberCount || 0 }));
        setMutedUsers(prev => ({ ...prev, [groupId]: data.mutedList || [] }));
        setLoading(prev => ({ ...prev, [groupId]: false }));
      })
      .catch(() => setLoading(prev => ({ ...prev, [groupId]: false })));
  }

  function selectGroup(g) {
    setActiveGroup(g.id);
    loadGroup(g.id);
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
        if (!mdoc.group) return;
        const gid = mdoc.group;
        if (messages[gid] !== undefined) {
          setMessages(prev => ({ ...prev, [gid]: [...prev[gid], mdoc] }));
        }
        if (gid === activeGroup) setTimeout(scrollBottom, 50);
      };
    }
  }, [WebSocket, activeGroup]);

  async function sendMessage() {
    const val = (input[activeGroup] || '').trim();
    if (!val || isPosting) return;
    setIsPosting(true);
    setInput(prev => ({ ...prev, [activeGroup]: '' }));
    try {
      const res = await request.post('', {
        operation: 'send',
        group: activeGroup,
        content: val,
      });
      if (res.mdoc) {
        setMessages(prev => ({ ...prev, [activeGroup]: [...(prev[activeGroup] || []), res.mdoc] }));
        setTimeout(scrollBottom, 50);
      }
    } catch (e) {
      Notification.error(e.message || '发送失败');
    } finally {
      setIsPosting(false);
    }
  }

  async function deleteMessage(msgId) {
    try {
      await request.post('', { operation: 'deleteMessage', messageId: msgId });
      setMessages(prev => ({
        ...prev,
        [activeGroup]: (prev[activeGroup] || []).filter(m => m._id.toString() !== msgId.toString()),
      }));
    } catch (e) {
      Notification.error(e.message || '删除失败');
    }
  }

  async function toggleMute(uid, uname) {
    try {
      if (muted[activeGroup]) {
        await request.post('', { operation: 'unmuteUser', uid, group: activeGroup });
      } else {
        await request.post('', { operation: 'muteUser', uid, group: activeGroup });
      }
      Notification.info(`已${muted[activeGroup] ? '解除' : '禁言'} ${uname}`);
      loadGroup(activeGroup);
    } catch (e) {
      Notification.error(e.message || '操作失败');
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendMessage();
    }
  }

  function renderTime(id) {
    const ts = new Date();
    ts.setTime(parseInt(id.substring(0, 8), 16) * 1000);
    return ts.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function renderSidebar() {
    return (
      <div className="messagepad__sidebar">
        <div className="section__header messagepad__search">
          <span style={{ fontWeight: 700, fontSize: '15px', color: '#3A3A38', flex: 1 }}>群聊</span>
        </div>
        <ol className="messagepad__list" style={{ overflow: 'auto', maxHeight: 'calc(100vh - 200px)' }}>
          {GROUPS.map((g) => (
            <div
              key={g.id}
              className="messagepad__user-item"
              onClick={() => selectGroup(g)}
            >
              <span style={{ fontSize: '24px', flexShrink: 0 }}>{g.icon}</span>
              <div className="messagepad__user-meta">
                <div className="messagepad__username">{g.name}</div>
                <div className="messagepad__desc">{g.desc}</div>
              </div>
            </div>
          ))}
        </ol>
      </div>
    );
  }

  function renderContent() {
    if (!activeGroup) {
      return (
        <div style={{
          position: 'absolute', left: '260px', right: 0, top: 0, bottom: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#9A9690', fontSize: '14px',
        }}>
          选择一个群开始聊天
        </div>
      );
    }

    const group = GROUPS.find(g => g.id === activeGroup);
    const msgList = messages[activeGroup] || [];
    const isAdmin_ = isAdmin[activeGroup];
    const muted_ = muted[activeGroup];
    const loading_ = loading[activeGroup];

    return (
      <>
        <div className="messagepad__header">
          {isMobile() && (
            <button className="messagepad__back-btn" onClick={() => setMobileOpen(false)} title="返回">
              <span>←</span>
            </button>
          )}
          <a className="messagepad__content__header__title">
            {group.icon} {group.name} ({memberCount[activeGroup] || 0}人)
          </a>
          {isAdmin_ && (
            <button
              onClick={() => setShowMutedList(!showMutedList)}
              style={{
                marginLeft: 'auto', padding: '6px 12px', border: '1px solid #E8E6E2',
                borderRadius: '8px', background: '#FAFAF8', cursor: 'pointer', fontSize: '13px', color: '#6A6560',
              }}
            >
              禁言管理
            </button>
          )}
        </div>

        {showMutedList && isAdmin_ && (
          <div style={mutedListStyle}>
            <div style={{ fontWeight: 700, marginBottom: '10px' }}>已禁言用户</div>
            {(mutedUsers[activeGroup] || []).length === 0 && (
              <div style={{ color: '#9A9690' }}>暂无禁言用户</div>
            )}
            {(mutedUsers[activeGroup] || []).map((u) => (
              <div key={u.uid} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 0', borderBottom: '1px solid #F0EFEB' }}>
                <span style={{ flex: 1, fontSize: '14px' }}>{u.uname || `UID ${u.uid}`}</span>
                <button
                  onClick={async () => {
                    try {
                      await request.post('', { operation: 'unmuteUser', uid: u.uid, group: activeGroup });
                      const newMuted = (mutedUsers[activeGroup] || []).filter(x => x.uid !== u.uid);
                      setMutedUsers(prev => ({ ...prev, [activeGroup]: newMuted }));
                      Notification.info('已解除禁言');
                    } catch (e) { Notification.error('操作失败'); }
                  }}
                  style={muteBtnStyle}
                >
                  解除
                </button>
              </div>
            ))}
            <button onClick={() => setShowMutedList(false)} style={{ ...muteBtnStyle, marginTop: '12px' }}>关闭</button>
          </div>
        )}

        <ol className="messagepad__content" ref={(ref) => { contentRef.current[activeGroup] = ref; }}>
          {loading_ ? (
            <div style={{ textAlign: 'center', padding: '20px', color: '#9A9690' }}>加载中...</div>
          ) : (
            msgList.map((msg) => {
              const isSelf = msg.from === UserContext._id;
              const fromUser = msg.fromUser || {};
              return (
                <li key={msg._id} className={`messagepad__message ${isSelf ? 'side--self' : 'side--other'}`}>
                  <div className="messagepad__message__avatar">
                    <img src={isSelf ? UserContext.avatarUrl : (fromUser.avatarUrl || '')} width="50" height="50" className="medium user-profile-avatar" />
                  </div>
                  <div className="messagepad__message__body" style={isSelf ? { background: 'linear-gradient(135deg, #F7F7F5 0%, #F0EFEB 100%)', order: -1 } : { background: 'linear-gradient(135deg, #F0EFEB 0%, #E8E6E2 100%)', order: 1, marginLeft: '20px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                      <span style={{ fontWeight: 600, fontSize: '13px', color: isSelf ? '#6A6560' : '#3A3A38' }}>
                        {isSelf ? '我' : (fromUser.uname || `UID ${msg.from}`)}
                      </span>
                      {isAdmin_ && msg.from !== 1 && (
                        <button onClick={() => toggleMute(msg.from, fromUser.uname)} style={muteBtnStyle}>
                          禁言
                        </button>
                      )}
                      {isAdmin_ && (
                        <button onClick={() => deleteMessage(msg._id)} style={{ ...muteBtnStyle, background: '#FBF1F1', color: '#B59B9B', borderColor: '#ECD5D5' }}>
                          删除
                        </button>
                      )}
                    </div>
                    <div>{msg.content}</div>
                    <time style={{ opacity: 0.5, fontSize: '12px', marginTop: '4px', display: 'block', textAlign: 'right' }}>
                      {renderTime(msg._id)}
                    </time>
                  </div>
                </li>
              );
            })
          )}
        </ol>

        {muted_ ? (
          <div style={{ position: 'absolute', left: '260px', right: 0, bottom: 0, height: '80px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#FAFAF8', borderTop: '1px solid #E8E6E2', color: '#9A9690', fontSize: '14px' }}>
            你已被禁言，无法发送消息
          </div>
        ) : (
          <div className="messagepad__input" style={{ display: 'block', left: '260px' }}>
            <div className="messagepad__textarea-container">
              <textarea
                ref={(ref) => { inputRef.current[activeGroup] = ref; }}
                data-markdown
                disabled={isPosting}
                value={input[activeGroup] || ''}
                placeholder={`发送到 ${group.name}... (Ctrl+Enter 发送)`}
                onKeyDown={handleKeyDown}
                onChange={(e) => setInput(prev => ({ ...prev, [activeGroup]: e.target.value }))}
              />
            </div>
            <button disabled={!input[activeGroup]?.trim() || isPosting} onClick={sendMessage}>
              <i className="material-icons" style={{ fontSize: '20px' }}>send</i>
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="messagepad clearfix">
      {renderSidebar()}
      {renderContent()}
    </div>
  );
}

const muteBtnStyle = {
  padding: '2px 8px',
  border: '1px solid #E8E6E2',
  borderRadius: '6px',
  background: '#FAFAF8',
  cursor: 'pointer',
  fontSize: '11px',
  color: '#6A6560',
};

const mutedListStyle = {
  position: 'absolute',
  left: '260px',
  right: 0,
  top: '48px',
  bottom: '80px',
  background: '#FFFFFF',
  padding: '20px',
  overflow: 'auto',
  zIndex: 10,
  borderRight: '1px solid #E8E6E2',
};