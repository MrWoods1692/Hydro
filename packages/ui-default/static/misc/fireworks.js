/* Hydro 奎光 fork：判题结果 AC 时播放烟花 + 礼花祝贺动画。
 * 监听 #status 元素的 data-status（数字）与 record-status--text 的 AC 类名，
 * 任一命中即触发一次；canvas 全屏粒子烟花 + 金色礼花飘落，结束后自清理。
 */
(function () {
    if (window.__hydroFireworksFired) return; // 同一页面只播一次
    var AC_STATUS = '2';
    var AC_CLASS = /(^|\s)AC(\s|$)/i;
    var seen = null;

    function hasAC() {
        var box = document.querySelector('#status');
        if (!box) return false;
        var s = String(box.getAttribute('data-status') || '');
        var text = box.querySelector('.record-status--text');
        var cls = text && String(text.className || '');
        return s === AC_STATUS || AC_CLASS.test(cls);
    }

    function fire() {
        if (!hasAC() || window.__hydroFireworksFired) return;
        window.__hydroFireworksFired = true;
        launch();
        // 转成 AC 前可能是其他状态，之后不再重复触发
    }

    function check() {
        if (window.__hydroFireworksFired) return;
        var now = hasAC();
        if (now && !seen) fire();
        seen = seen || now;
    }

    // 初始加载已是 AC（如打开历史 AC 记录）也祝贺，但延迟到 DOM 稳定。
    var initial = setTimeout(function () { check(); }, 800);

    var mo = new MutationObserver(function () { check(); });
    mo.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-status'],
    });
    window.addEventListener('beforeunload', function () {
        clearTimeout(initial);
        mo.disconnect();
    });

    /* ---------- 烟花粒子系统 ---------- */
    var COLORS = ['#C9A227', '#FFD75E', '#9E1B1B', '#35B37E', '#FFFFFF', '#F2A93B'];
    function rand(a, b) { return a + Math.random() * (b - a); }

    function launch() {
        var canvas = document.createElement('canvas');
        canvas.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;z-index:2147483000;pointer-events:none;';
        document.body.appendChild(canvas);
        var ctx = canvas.getContext('2d');
        var W = (canvas.width = window.innerWidth);
        var H = (canvas.height = window.innerHeight);
        var particles = [];
        var confetti = [];
        var started = Date.now();
        var DURATION = 7600;
        var confettiUntil = started + 4600;
        var gone = false;

        function burst(x, y) {
            var n = 60;
            var color = COLORS[(Math.random() * COLORS.length) | 0];
            var base = Math.atan2(y - H * 0.55, x - W / 2);
            for (var i = 0; i < n; i++) {
                var angle = rand(0, Math.PI * 2);
                var speed = rand(2.5, 8.5);
                particles.push({
                    x: x, y: y,
                    vx: Math.cos(angle) * speed,
                    vy: Math.sin(angle) * speed,
                    life: 1,
                    decay: rand(0.007, 0.016),
                    color: Math.random() < 0.5 ? color : COLORS[(Math.random() * COLORS.length) | 0],
                    r: rand(1.5, 3.2),
                });
            }
        }

        function popConfetti() {
            var n = 26;
            for (var i = 0; i < n; i++) {
                confetti.push({
                    x: rand(0, W),
                    y: rand(-H * 0.3, 0),
                    w: rand(5, 9),
                    h: rand(8, 13),
                    vy: rand(1.6, 3.4),
                    vx: rand(-0.6, 0.6),
                    rot: rand(0, Math.PI),
                    vr: rand(-0.12, 0.12),
                    color: COLORS[(Math.random() * COLORS.length) | 0],
                });
            }
        }

        // 主礼花序列：右/左/右三次大型绽放 + 中景零星
        setTimeout(function () { burst(W * 0.78, H * 0.32); }, 120);
        setTimeout(function () { burst(W * 0.22, H * 0.26); }, 900);
        setTimeout(function () { burst(W * 0.5, H * 0.18); popConfetti(); }, 1700);
        setTimeout(function () { burst(W * 0.68, H * 0.45); }, 2600);
        setTimeout(function () { burst(W * 0.34, H * 0.4); popConfetti(); }, 3300);

        function frame() {
            if (gone) return;
            var now = Date.now();
            var t = now - started;
            ctx.clearRect(0, 0, W, H);
            // 礼花飘落
            if (now < confettiUntil) {
                for (var i = confetti.length - 1; i >= 0; i--) {
                    var cf = confetti[i];
                    cf.y += cf.vy; cf.x += cf.vx; cf.rot += cf.vr;
                    if (cf.y > H + 20) confetti.splice(i, 1);
                    else {
                        ctx.save();
                        ctx.translate(cf.x, cf.y);
                        ctx.rotate(cf.rot);
                        ctx.fillStyle = cf.color;
                        ctx.globalAlpha = Math.min(1, (confettiUntil - now) / 1200);
                        ctx.fillRect(-cf.w / 2, -cf.h / 2, cf.w, cf.h);
                        ctx.restore();
                    }
                }
            }
            // 烟花粒子
            for (var j = particles.length - 1; j >= 0; j--) {
                var p = particles[j];
                p.vx *= 0.985;
                p.vy = p.vy * 0.985 + 0.12;
                p.x += p.vx;
                p.y += p.vy;
                p.life -= p.decay;
                if (p.life <= 0) { particles.splice(j, 1); continue; }
                ctx.globalAlpha = Math.max(0, p.life);
                ctx.fillStyle = p.color;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
            if (t > DURATION && particles.length === 0 && confetti.length === 0) {
                gone = true;
                canvas.remove();
                return;
            }
            requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
    }
})();