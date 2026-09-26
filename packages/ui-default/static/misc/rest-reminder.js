/* Hydro 奎光 fork：长时间在线休息提醒。
 * 计时基于 sessionStorage（同一标签页内跨页面导航/刷新保持）；
 * 切到其他标签页或离开站点超过 RESET_AFTER_HIDE_S 秒视为已休息并重置。
 * 达到 REST_MINUTES 后弹出休息提示卡片；「去休息一下」完全重置，
 * 「再学 5 分钟」把下次提醒推迟 5 分钟。阈值改 REST_MINUTES 即可。
 */
(function () {
    if (window.__restReminderLoaded) return;
    window.__restReminderLoaded = true;

    var REST_MINUTES = 45;            // 提醒阈值（分钟）
    var RESET_AFTER_HIDE_S = 60;      // 离开页面超过该秒数视为已休息
    var KEY_BASE = 'restReminder.base';
    var LIMIT = REST_MINUTES * 60 * 1000;

    function readBase() {
        var t = parseInt(sessionStorage.getItem(KEY_BASE) || '', 10);
        if (!t || isNaN(t)) { t = Date.now(); reset(); }
        return t;
    }
    function reset() {
        try { sessionStorage.setItem(KEY_BASE, String(Date.now())); } catch (e) { }
    }
    function setBase(t) {
        try { sessionStorage.setItem(KEY_BASE, String(t)); } catch (e) { }
    }

    // 切到其他标签页视为休息：回到本页时若离开超过阈值则重置计时
    var hiddenAt = null;
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
            hiddenAt = Date.now();
        } else if (hiddenAt) {
            if (Date.now() - hiddenAt > RESET_AFTER_HIDE_S * 1000) reset();
            hiddenAt = null;
        }
    }, false);

    var showing = false;
    function maybeRemind() {
        if (showing) return;
        if (Date.now() - readBase() < LIMIT) return;
        showing = true;
        showModal();
    }

    function showModal() {
        var overlay = document.createElement('div');
        overlay.setAttribute('role', 'alert');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(72,54,26,0.32);z-index:2147483001;display:flex;align-items:center;justify-content:center;animation:restFade .3s ease-out;backdrop-filter:blur(2px);';
        var card = document.createElement('div');
        card.style.cssText = 'background:#FFFDF8;border:2px solid #C9A227;border-radius:18px;box-shadow:0 16px 48px rgba(120,84,20,0.28);padding:30px 34px 26px;max-width:380px;text-align:center;font-family:var(--font-family),sans-serif;color:#4C453A;animation:restPop .35s cubic-bezier(.2,1.4,.4,1);';
        card.innerHTML =
            '<div style="font-size:44px;line-height:1;margin-bottom:6px;">\u2615</div>' +
            '<div style="font-size:19px;font-weight:700;color:#6B4F0F;letter-spacing:.08em;margin-bottom:10px;">该休息一下啦</div>' +
            '<div style="font-size:14px;line-height:1.8;color:#6E6550;margin-bottom:20px;">你已经连续学习 ' + REST_MINUTES + ' 分钟了，<br>站起来看看窗外、远眺 2 分钟，<br>眼睛和肩膀都会感谢你～</div>' +
            '<div style="display:flex;gap:12px;justify-content:center;">' +
            '<button type="button" class="rest-btn rest-btn--primary" style="flex:1;padding:10px 0;border:0;border-radius:999px;background:#A87C2B;color:#fff;font-size:14px;font-weight:700;cursor:pointer;">去休息一下</button>' +
            '<button type="button" class="rest-btn rest-btn--ghost" style="flex:1;padding:10px 0;border:2px solid #C9A227;border-radius:999px;background:transparent;color:#8A6A12;font-size:14px;font-weight:700;cursor:pointer;">再学 5 分钟</button>' +
            '</div>';
        overlay.appendChild(card);
        document.body.appendChild(overlay);

        function close(fullReset) {
            showing = false;
            if (fullReset) reset();
            else setBase(Date.now() - (LIMIT - 5 * 60 * 1000)); // 5 分钟后再次提醒
            overlay.remove();
        }
        card.querySelector('.rest-btn--primary').addEventListener('click', function () { close(true); });
        card.querySelector('.rest-btn--ghost').addEventListener('click', function () { close(false); });
        overlay.addEventListener('click', function (e) { if (e.target === overlay) close(true); });
    }

    var anim = document.createElement('style');
    anim.textContent = '@keyframes restFade{from{opacity:0}}@keyframes restPop{from{opacity:0;transform:scale(.86) translateY(12px)}}';
    document.head.appendChild(anim);

    // 加载后稍等再检查，避免打断首屏渲染；之后每 30s 检查一次。
    setTimeout(maybeRemind, 6000);
    setInterval(maybeRemind, 30 * 1000);
})();