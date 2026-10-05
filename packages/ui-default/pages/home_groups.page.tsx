import { createRoot } from 'react-dom/client';
import $ from 'jquery';
import { NamedPage } from 'vj/misc/Page';

const page = new NamedPage('home_groups', () => {
  async function mount() {
    const { default: WebSocket } = await import('../components/socket');
    const sid = document.cookie.split('sid=')[1]?.split(';')[0];
    const sock = new WebSocket(`${UiContext.ws_prefix}websocket`);
    sock.onopen = () => {
      sock.send(JSON.stringify({
        operation: 'subscribe',
        request_id: Math.random().toString(16).substring(2),
        credential: sid,
        channels: ['groupchat'],
      }));
    };

    const root = createRoot($('#groupChat').get(0));
    const { default: App } = await import('../components/groupchat');
    root.render(<App WebSocket={sock} />);
  }

  mount();
});

export default page;
