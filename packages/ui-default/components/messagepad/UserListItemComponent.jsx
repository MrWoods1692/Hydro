import classNames from 'classnames';
import PropTypes from 'prop-types';
import React, { memo } from 'react';
import Icon from 'vj/components/react/IconComponent';

function UserListItemComponent(props) {
  const {
    userName,
    subtitle,
    faceUrl,
    active,
    onClick,
    onProfile,
    onProfileTitle,
    ...rest
  } = props;
  return (
    <li {...rest}>
      <a
        className={classNames('messagepad__user-item media', { active })}
        onClick={(e) => {
          e.preventDefault();
          onClick();
        }}
      >
        <div className="media__left middle">
          <img src={faceUrl} alt={userName} width="46" height="46" className="medium user-profile-avatar" />
        </div>
        <div className="media__body middle messagepad__user-meta">
          <h3 className="messagepad__username">{userName}</h3>
          <div className="messagepad__desc">{subtitle}</div>
        </div>
        <button
          className="messagepad__user-profile-btn"
          title={onProfileTitle}
          data-tooltip={onProfileTitle}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onProfile();
          }}
        >
          <Icon name="user" />
        </button>
      </a>
    </li>
  );
}

UserListItemComponent.propTypes = {
  userName: PropTypes.string.isRequired,
  subtitle: PropTypes.string,
  faceUrl: PropTypes.string,
  active: PropTypes.bool,
  onClick: PropTypes.func.isRequired,
  onProfile: PropTypes.func,
  onProfileTitle: PropTypes.string,
};

export default memo(UserListItemComponent);
