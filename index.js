/**
 * nicoCopyPanel —— 聊天气泡复制面板
 * ------------------------------------------------------------
 * 手机端：长按聊天气泡（用户消息 / 角色消息均可）弹出复制小面板
 * 电脑端：右键点击聊天气泡弹出复制小面板
 *
 * 纯前端实现，不修改 SillyTavern 核心代码；
 * 在扩展管理器中禁用或删除本扩展即可完全移除该功能。
 */

(function () {
    'use strict';

    // 防止扩展被重复加载（重复绑定事件 / 复制执行两次）
    if (window.__nicoCopyPanelLoaded) return;
    window.__nicoCopyPanelLoaded = true;

    const LONG_PRESS_MS = 500;   // 长按判定时长（毫秒）
    const MOVE_THRESHOLD = 12;   // 手指移动超过该距离即判定为滚动并取消长按（px）
    const COPY_COOLDOWN_MS = 800; // 两次复制的最小间隔，防连点/双击/幽灵点击导致重复复制

    let panel = null;
    let longPressTimer = null;
    let longPressTriggered = false;
    let suppressContextMenu = false;
    let touchStartX = 0;
    let touchStartY = 0;
    let touchMes = null;
    let activeMes = null;
    let lastCopyAt = 0;
    let copying = false;

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

        panel.querySelector('.copy-panel-btn').addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!activeMes || copying) return;
            const now = Date.now();
            if (now - lastCopyAt < COPY_COOLDOWN_MS) return;
            lastCopyAt = now;
            copying = true;
            try {
                const text = getBubbleText(activeMes);
                if (!text) return;
                const ok = await copyToClipboard(text);
                const btn = panel.querySelector('.copy-panel-btn');
                const label = btn.querySelector('.copy-panel-label');
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
    }

    function suppressTextSelection() {
        const style = document.body.style;
        const prevUserSelect = style.userSelect;
        const prevWebkitUserSelect = style.webkitUserSelect;
        style.userSelect = 'none';
        style.webkitUserSelect = 'none';
        setTimeout(() => {
            style.userSelect = prevUserSelect;
            style.webkitUserSelect = prevWebkitUserSelect;
        }, 500);
    }

    /* ---------- 事件绑定 ---------- */

    function init() {
        // 电脑端：右键弹出复制面板
        document.addEventListener('contextmenu', (e) => {
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
            if (!mes || isExcluded(e.target)) return;
            e.preventDefault();
            showPanel(mes, e.clientX, e.clientY, false);
        });

        // 手机端：长按弹出复制面板
        document.addEventListener('touchstart', (e) => {
            const mes = getMes(e.target);
            if (!mes || isExcluded(e.target)) return;
            clearTimeout(longPressTimer);
            longPressTriggered = false;
            const touch = e.touches[0];
            if (!touch) return;
            touchStartX = touch.clientX;
            touchStartY = touch.clientY;
            touchMes = mes;
            longPressTimer = setTimeout(() => {
                longPressTriggered = true;
                suppressContextMenu = true;
                suppressTextSelection();
                showPanel(touchMes, touchStartX, touchStartY, true);
                setTimeout(() => { suppressContextMenu = false; }, 1200);
            }, LONG_PRESS_MS);
        }, { passive: true });

        // 手指移动过大 → 判定为滚动，取消长按
        document.addEventListener('touchmove', (e) => {
            if (!longPressTimer) return;
            const touch = e.touches[0];
            if (!touch) return;
            if (Math.abs(touch.clientX - touchStartX) > MOVE_THRESHOLD ||
                Math.abs(touch.clientY - touchStartY) > MOVE_THRESHOLD) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
                longPressTriggered = false;
            }
        }, { passive: true });

        const cancelLongPress = () => {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        };
        document.addEventListener('touchend', cancelLongPress);
        document.addEventListener('touchcancel', cancelLongPress);

        // 点击 / 触摸面板以外区域 → 隐藏
        document.addEventListener('pointerdown', (e) => {
            if (!panel || !panel.classList.contains('show')) return;
            if (e.target instanceof Element && e.target.closest('#nicoCopyPanel')) return;
            hidePanel();
        }, true);

        // 滚动、窗口大小变化、Esc → 隐藏
        document.addEventListener('scroll', () => hidePanel(), { capture: true, passive: true });
        window.addEventListener('resize', () => hidePanel());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') hidePanel();
        });

        // 消息更新 / 编辑 / 删除 / 滑动 / 切换聊天时隐藏，避免指向已失效的气泡
        try {
            const context = SillyTavern.getContext();
            const { eventTypes, eventSource } = context;
            const events = ['MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'CHAT_CHANGED'];
            for (const name of events) {
                if (eventTypes[name]) eventSource.on(eventTypes[name], () => hidePanel());
            }
        } catch (_) {
            /* SillyTavern API 不可用时忽略 */
        }

        console.log('[nicoCopyPanel] 已加载：手机端长按 / 电脑端右键聊天气泡即可弹出复制面板。');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
