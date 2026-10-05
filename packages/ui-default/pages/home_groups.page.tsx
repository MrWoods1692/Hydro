import React from 'react';
import { createRoot } from 'react-dom/client';
import $ from 'jquery';
import { NamedPage } from 'vj/misc/Page';
import { request } from 'vj/utils';
import { ctx } from 'vj/context';

class GroupChatService extends Service {
  WebSocket: typeof import('../components/socket').default;
}

declare module 'cordis' {
  interface Context {
    groupchat: GroupChatService;
  }
}

const page = new NamedPage('home_groups', () => {
  async function mount() {
    const { default: WebSocket } = await import('../components/socket');
    const sock = new WebSocket(`${UiContext.ws_prefix}websocket`);
    sock.onopen = () => {
      sock.send(JSON.stringify({
        operation: 'subscribe',
        request_id: Math.random().toString(16).substring(2),
        credential: document.cookie.split('sid=')[1].split(';')[0],
        channels: ['groupchat'],
      }));
    };

    const root = createRoot($('#groupChat').get(0));
    const { default: App } = await import('../components/groupchat');
    root.render(<App WebSocket={sock} />);

    ctx.plugin(GroupChatService, { WebSocket: sock });
  }

  mount();
});

export default page;