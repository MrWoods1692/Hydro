import PropTypes from 'prop-types';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { connect } from 'react-redux';
import Icon from 'vj/components/react/IconComponent';
import { api, i18n, request } from 'vj/utils';
import MessagePadDialogueContent from './MessagePadDialogueContentContainer';
import MessagePadInput from './MessagePadInputContainer';
import UserListItem from './UserListItemComponent';

const PROJECTION = ['_id', 'uname', 'displayName', 'avatarUrl'];

const mapDispatchToProps = (dispatch) => ({
  loadDialogues() {
    dispatch({
      type: 'DIALOGUES_LOAD_DIALOGUES',
      payload: request.get('', { _: Date.now() }),
    });
  },
  clearActive() {
    dispatch({
      type: 'DIALOGUES_SWITCH_TO',
      payload: null,
    });
  },
});

const MessagePadContainer = ({ onAdd, activeId, clearActive }) => {
  const [users, setUsers] = useState([]);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api('users', { all: true }, PROJECTION);
      setUsers(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    if (activeId === null) return;
    api('users', { search: String(activeId), exact: true }, PROJECTION)
      .then((data) => {
        if (Array.isArray(data) && data.length) {
          setUsers((prev) => (prev.some((u) => u._id === data[0]._id) ? prev : prev.concat(data)));
        }
      })
      .catch(() => { });
  }, [activeId]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return users;
    return users.filter((u) => (
      (u.uname && u.uname.toLowerCase().includes(kw))
      || (u.displayName && u.displayName.toLowerCase().includes(kw))
      || String(u._id).includes(kw)
    ));
  }, [users, keyword]);

  function openProfile(uid) {
    window.location.href = `/user/${uid}`;
  }

  const cn = ['messagepad', 'clearfix'];
  if (activeId !== null) cn.push('has-active-dialogue');

  return (
    <div className={cn.join(' ')}>
      <div className="messagepad__sidebar">
        <div className="section__header messagepad__search">
          <Icon name="search" className="messagepad__search__icon" />
          <input
            className="messagepad__search__input"
            type="text"
            placeholder={i18n('Search User')}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          {keyword
            ? <button className="messagepad__search__clear" onClick={() => setKeyword('')} title={i18n('Clear')}>×</button>
            : null}
        </div>
        <ol className="messagepad__list" style={{ overscrollBehavior: 'contain' }}>
          {loading
            ? <li className="messagepad__list__status">{i18n('Loading...')}</li>
            : error
              ? <li className="messagepad__list__status">{error}</li>
              : filtered.length === 0
                ? <li className="messagepad__list__status">{i18n('No User')}</li>
                : filtered.map((u) => (
                  <UserListItem
                    key={u._id}
                    userName={u.uname}
                    subtitle={u.displayName && u.displayName !== u.uname ? u.displayName : `UID ${u._id}`}
                    faceUrl={u.avatarUrl}
                    active={u._id === activeId}
                    onClick={() => onAdd(u)}
                    onProfile={() => openProfile(u._id)}
                    onProfileTitle={i18n('View Profile')}
                  />
                ))}
        </ol>
      </div>
      <MessagePadDialogueContent onBack={clearActive} />
      <MessagePadInput />
    </div>
  );
};

MessagePadContainer.propTypes = {
  onAdd: PropTypes.func.isRequired,
  activeId: PropTypes.number,
  clearActive: PropTypes.func.isRequired,
};

export default connect((state) => ({ activeId: state.activeId }), mapDispatchToProps)(MessagePadContainer);
