/**
 * nicoCopyPanel —— 聊天气泡复制面板
 * ------------------------------------------------------------
 * 手机端：长按用户聊天气泡弹出复制小面板
 * 电脑端：右键用户聊天气泡弹出复制小面板
 * 仅对用户消息生效，角色（AI）消息不弹出复制面板、不干预原生交互。
 *
 * v1.2.0 修复：
 * - 长按开始时立即抑制文本选择（user-select + touch-callout），
 *   从源头阻止 iOS 放大镜/选择手柄与 Android 原生菜单覆盖面板；
 * - 事件全部存储引用，支持重复初始化（ST 禁用/启用扩展、热更新脚本）
 *   先解绑旧监听再重绑，不再出现"加载了却没反应"；
 * - 长按触发后面板稳定显示，不受系统补发右键/合成点击干扰。
 *
 * 纯前端实现，不修改 SillyTavern 核心代码；
 * 在扩展管理器中禁用或删除本扩展即可完全移除该功能。
 */

(function () {
    'use strict';

    const LONG_PRESS_MS = 500;    // 长按判定时长（毫秒）
    const MOVE_THRESHOLD = 14;    // 手指移动超过该距离即判定为滚动并取消长按（px，容忍轻微抖动）
    const COPY_COOLDOWN_MS = 800; // 两次复制的最小间隔，防连点/双击/幽灵点击导致重复复制

    let panel = null;
    let longPressTimer = null;
    let longPressTriggered = false;
    let suppressContextMenu = false;
    let touchStartX = 0;
    let touchStartY = 0;
    let touchMes = null;
    let activeMes = null;
    let activeText = '';
    let lastCopyAt = 0;
    let copying = false;
    let suppressEl = null; // 当前被抑制选择的 .mes 元素

    // 这些区域保持原有交互，不弹复制面板（操作按钮 / 头像 / 选择框 / 滑动条 / 图片 / 链接 / 输入框等）
    const EXCLUDED_SELECTOR = [
        '.mes_buttons',
        '.mes_edit_buttons',
        '.mesAvatarWrapper',
        '.avatar',
        '.for_checkbox',
        '.del_checkbox',
        '.swipe_left',
        '.swipe_right',
        '.swipes-counter',
        '.mes_media_wrapper',
        '.mes_file_wrapper',
        '.mes_reasoning',
        'a',
        'textarea',
        'input',
        'select',
        'button',
    ].join(', ');

    function isExcluded(target) {
        return target instanceof Element && !!target.closest(EXCLUDED_SELECTOR);
    }

    function getMes(target) {
        return target instanceof Element ? target.closest('.mes') : null;
    }

    // 仅用户消息生效：酒馆消息元素 .mes 带 is_user 属性（模板固定渲染 "true"/"false"）
    function isUserMes(mes) {
        return !!mes && typeof mes.getAttribute === 'function' && mes.getAttribute('is_user') === 'true';
    }

    function getBubbleText(mes) {
        const textEl = mes.querySelector('.mes_text');
        if (!textEl) return '';
        const raw = typeof textEl.innerText === 'string' && textEl.innerText
            ? textEl.innerText
            : (textEl.textContent || '');
        return raw.replace(/\n{3,}/g, '\n\n').trim();
    }

    function getSenderName(mes) {
        const nameEl = mes.querySelector('.name_text');
        if (nameEl && nameEl.textContent.trim()) return nameEl.textContent.trim();
        const chName = mes.getAttribute('ch_name');
        if (chName) return chName;
        return mes.getAttribute('is_user') === 'true' ? '用户' : '角色';
    }

    /* ---------- 长按文本选择抑制 ---------- */

    function addSuppress(mes) {
        if (!mes || mes === suppressEl) return;
        removeSuppress();
        suppressEl = mes;
        mes.classList.add('ncp-suppress');
    }

    function removeSuppress() {
        if (suppressEl) {
            suppressEl.classList.remove('ncp-suppress');
            suppressEl = null;
        }
    }

    /* ---------- 剪贴板 ---------- */

    async function copyToClipboard(text) {
        if (navigator.clipboard && window.isSecureContext) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch (_) {
                /* 走降级方案 */
            }
        }
        try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.setAttribute('readonly', '');
            textarea.style.position = 'fixed';
            textarea.style.left = '-9999px';
            textarea.style.top = '0';
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            textarea.setSelectionRange(0, textarea.value.length);
            try {
                return document.execCommand('copy');
            } finally {
                document.body.removeChild(textarea);
            }
        } catch (_) {
            return false;
        }
    }

    /* ---------- 面板 ---------- */

    function buildPanel() {
        // 防御：清理可能残留的重复面板元素，确保全局只有一份
        document.querySelectorAll('#nicoCopyPanel').forEach((el) => el.remove());
        panel = document.createElement('div');
        panel.id = 'nicoCopyPanel';
        panel.innerHTML =
            '<div class="copy-panel-sender"></div>' +
            '<button type="button" class="copy-panel-btn">' +
            '<i class="fa-solid fa-copy"></i>' +
            '<span class="copy-panel-label">复制</span>' +
            '</button>';
        document.body.appendChild(panel);

        const btn = panel.querySelector('.copy-panel-btn');
        const label = btn.querySelector('.copy-panel-label');
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!activeMes || copying) return;
            const now = Date.now();
            if (now - lastCopyAt < COPY_COOLDOWN_MS) return;
            lastCopyAt = now;
            copying = true;
            try {
                // 使用 showPanel 时缓存好的文本，避免再次读取 innerText（会触发重排，大消息时卡顿）
                const text = activeText;
                if (!text) return;
                const ok = await copyToClipboard(text);
                label.textContent = ok ? '已复制' : '复制失败';
                btn.classList.add('copied');
                setTimeout(() => {
                    label.textContent = '复制';
                    btn.classList.remove('copied');
                    hidePanel();
                }, 700);
            } finally {
                copying = false;
            }
        });
    }

    function getPanel() {
        if (!panel) buildPanel();
        return panel;
    }

    function positionPanel(x, y, above) {
        const el = getPanel();
        // 隐藏状态下先按未缩放尺寸测量，避免 scale 导致边缘越界
        const prevTransform = el.style.transform;
        el.style.transform = 'none';
        const rect = el.getBoundingClientRect();
        el.style.transform = prevTransform;

        const margin = 12;
        const vw = window.innerWidth || document.documentElement.clientWidth || 1024;
        const vh = window.innerHeight || document.documentElement.clientHeight || 768;

        let left = x + margin;
        let top = above ? y - rect.height - margin : y + margin;

        left = Math.max(margin, Math.min(left, vw - rect.width - margin));
        top = Math.max(margin, Math.min(top, vh - rect.height - margin));
        el.style.left = left + 'px';
        el.style.top = top + 'px';
    }

    function showPanel(mes, x, y, above) {
        const text = getBubbleText(mes);
        if (!text) return;
        activeMes = mes;
        activeText = text; // 缓存文本，点击复制时不再重复读取 DOM
        const el = getPanel();
        el.querySelector('.copy-panel-sender').textContent = getSenderName(mes);
        // 重置按钮状态，避免上一次的“已复制/复制失败”残留
        const btn = el.querySelector('.copy-panel-btn');
        btn.classList.remove('copied');
        btn.querySelector('.copy-panel-label').textContent = '复制';
        positionPanel(x, y, above);
        el.classList.add('show');
    }

    function hidePanel() {
        if (panel) panel.classList.remove('show');
        activeMes = null;
        activeText = '';
    }

    /* ---------- 事件绑定 ---------- */

    function init() {
        // ===== 重复初始化防护：先解绑旧监听再重绑 =====
        // ST 禁用/启用扩展或热更新脚本时会再次执行本文件；
        // 若直接 return 会导致事件永不绑定（表现为"没生效/面板不出现"）。
        const old = window.__nicoCopyPanelHandlers;
        if (old) {
            if (old.contextmenu) document.removeEventListener('contextmenu', old.contextmenu);
            if (old.touchstart) document.removeEventListener('touchstart', old.touchstart);
            if (old.touchmove) document.removeEventListener('touchmove', old.touchmove);
            if (old.touchend) document.removeEventListener('touchend', old.touchend);
            if (old.touchcancel) document.removeEventListener('touchcancel', old.touchcancel);
            if (old.pointerdown) document.removeEventListener('pointerdown', old.pointerdown, true);
            if (old.scroll) document.removeEventListener('scroll', old.scroll, true);
            if (old.keydown) document.removeEventListener('keydown', old.keydown);
            if (old.resize) window.removeEventListener('resize', old.resize);
        }
        // 清理残留面板与状态
        document.querySelectorAll('#nicoCopyPanel').forEach((el) => el.remove());
        panel = null;
        longPressTimer = null;
        longPressTriggered = false;
        suppressContextMenu = false;
        removeSuppress();

        // 电脑端：右键弹出复制面板
        const H = {};

        H.contextmenu = (e) => {
            if (e.target instanceof Element && e.target.closest('#nicoCopyPanel')) {
                e.preventDefault();
                return;
            }
            if (suppressContextMenu) {
                // 移动端长按后系统会补发一个右键事件，直接吞掉
                suppressContextMenu = false;
                e.preventDefault();
                return;
            }
            const mes = getMes(e.target);
            // 仅用户消息弹面板；角色（AI）消息不干预，保留浏览器默认右键菜单
            if (!mes || !isUserMes(mes) || isExcluded(e.target)) return;
            e.preventDefault();
            showPanel(mes, e.clientX, e.clientY, false);
        };

        // 手机端：长按弹出复制面板
        H.touchstart = (e) => {
            const mes = getMes(e.target);
            // 仅用户消息长按弹面板；角色（AI）消息保持原生长按行为（滚动/选择），零开销短路
            if (!mes || !isUserMes(mes) || isExcluded(e.target)) return;
            clearTimeout(longPressTimer);
            longPressTriggered = false;
            const touch = e.touches[0];
            if (!touch) return;
            touchStartX = touch.clientX;
            touchStartY = touch.clientY;
            touchMes = mes;
            // 长按一开始就抑制文本选择：从源头阻止 iOS 放大镜/选择手柄、
            // Android 原生文本选择菜单抢占/覆盖我们的复制面板
            addSuppress(mes);
            longPressTimer = setTimeout(() => {
                longPressTimer = null;
                longPressTriggered = true;
                suppressContextMenu = true;
                showPanel(touchMes, touchStartX, touchStartY, true);
                // 长按抬手后系统可能补发右键（Android），在窗口期内吞掉
                setTimeout(() => { suppressContextMenu = false; }, 1200);
            }, LONG_PRESS_MS);
        };

        // 手指移动过大 → 判定为滚动，取消长按
        H.touchmove = (e) => {
            if (!longPressTimer) return; // 未开始或已触发，零开销
            const touch = e.touches[0];
            if (!touch) return;
            if (Math.abs(touch.clientX - touchStartX) > MOVE_THRESHOLD ||
                Math.abs(touch.clientY - touchStartY) > MOVE_THRESHOLD) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
                longPressTriggered = false;
                removeSuppress();
            }
        };

        const cancelLongPress = () => {
            clearTimeout(longPressTimer);
            longPressTimer = null;
            longPressTriggered = false;
            // 稍延迟移除抑制，避免抬手瞬间系统弹出原生菜单
            setTimeout(removeSuppress, 300);
        };
        H.touchend = cancelLongPress;
        H.touchcancel = cancelLongPress;

        // 点击 / 触摸面板以外区域 → 隐藏
        H.pointerdown = (e) => {
            if (!panel || !panel.classList.contains('show')) return;
            if (e.target instanceof Element && e.target.closest('#nicoCopyPanel')) return;
            hidePanel();
        };

        // 滚动、Esc → 隐藏（未显示时零开销短路，滚动不卡顿）
        H.scroll = () => {
            if (!panel || !panel.classList.contains('show')) return;
            hidePanel();
        };
        H.keydown = (e) => {
            if (e.key === 'Escape') hidePanel();
        };
        H.resize = () => hidePanel();

        document.addEventListener('contextmenu', H.contextmenu);
        document.addEventListener('touchstart', H.touchstart, { passive: true });
        document.addEventListener('touchmove', H.touchmove, { passive: true });
        document.addEventListener('touchend', H.touchend);
        document.addEventListener('touchcancel', H.touchcancel);
        document.addEventListener('pointerdown', H.pointerdown, true);
        document.addEventListener('scroll', H.scroll, true);
        document.addEventListener('keydown', H.keydown);
        window.addEventListener('resize', H.resize);

        // 保存引用，供重复初始化时解绑
        window.__nicoCopyPanelHandlers = H;

        // 消息更新 / 编辑 / 删除 / 滑动 / 切换聊天时隐藏，避免指向已失效的气泡
        try {
            const context = SillyTavern.getContext();
            const { eventTypes, eventSource } = context;
            const events = ['MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'CHAT_CHANGED'];
            // 先移除旧的事件订阅（重复初始化时）
            if (window.__nicoCopyPanelStEvents) {
                for (const name of Object.keys(window.__nicoCopyPanelStEvents)) {
                    try {
                        eventSource.removeListener(eventTypes[name], window.__nicoCopyPanelStEvents[name]);
                    } catch (_) { /* 忽略 */ }
                }
            }
            const stEvents = {};
            for (const name of events) {
                stEvents[name] = () => hidePanel();
                if (eventTypes[name]) eventSource.on(eventTypes[name], stEvents[name]);
            }
            window.__nicoCopyPanelStEvents = stEvents;
        } catch (_) {
            /* SillyTavern API 不可用时忽略 */
        }

        console.log('[nicoCopyPanel] v1.2.0 已加载：仅用户消息生效——手机端长按 / 电脑端右键用户聊天气泡弹出复制面板。');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
