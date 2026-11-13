/**
 * Browser half of the corner restart button.
 *
 * The button lives in `shell.overlay`, so it floats above DS Bot's own columns
 * (left rail, right panel, composer) and stays pinned to the bottom-right
 * corner while the workspace scrolls. It only draws the control and the
 * confirmation card; the restart itself is served by this plugin's own Host
 * half (index.js + lib/, vendored from dsh-restart-now 1.3.0, MIT), so the
 * button keeps working even when that other plugin is not installed.
 */
window.__ModuleLoader__.load({
  id: 'dsh-bot-restart-btn',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const NS = 'dsh-bot-restart-btn';
    const PROBE = '/plugins/dsh-bot-restart-btn/environment';
    const ACTION = '/plugins/dsh-bot-restart-btn/restart';

    const ZH = {
      'fab.label': '重启 DSH',
      'fab.hint': '重启 DeepSeek Harness，应用会关闭并自动重新打开',
      'confirm.title': '重启 DSH？',
      'confirm.body': '正在运行的任务会被中断，应用会在几秒后重新打开。',
      'confirm.cancel': '取消',
      'confirm.ok': '重启',
      'busy.title': '有任务正在运行',
      'busy.body': '当前有 {tasks} 个任务在进行，重启会中断它们。',
      'busy.cancel': '取消',
      'busy.wait': '等空闲后重启',
      'busy.force': '强制重启',
      'waiting.title': '等待任务结束后重启',
      'waiting.body': '还有 {tasks} 个任务在跑，完成后应用会自动重启。',
      'waiting.cancel': '取消等待',
      'restarting.title': '正在重启…',
      'restarting.body': '窗口会自动关闭并重新打开，请稍候。',
      'restarting.manual': '若 30 秒内没有重新打开，请手动启动应用。',
      'error.close': '知道了',
      'error.installing': '有插件正在安装，请稍后再重启。',
      'error.cooldown': '刚重启过，请 {seconds} 秒后再试。',
      'error.unauthorized': '当前页面未通过鉴权，无法重启。',
      'error.forbidden': '重启已被禁用。',
      'error.reason': '重启失败：{reason}',
    };

    const EN = {
      'fab.label': 'Restart DSH',
      'fab.hint': 'Restart DeepSeek Harness; the app closes and reopens by itself',
      'confirm.title': 'Restart DSH?',
      'confirm.body': 'Running tasks will be interrupted. The app reopens in a few seconds.',
      'confirm.cancel': 'Cancel',
      'confirm.ok': 'Restart',
      'busy.title': 'Tasks are running',
      'busy.body': '{tasks} tasks are still running; restarting interrupts them.',
      'busy.cancel': 'Cancel',
      'busy.wait': 'Wait, then restart',
      'busy.force': 'Force restart',
      'waiting.title': 'Waiting for tasks to finish',
      'waiting.body': '{tasks} tasks are still running; the app restarts once they finish.',
      'waiting.cancel': 'Cancel waiting',
      'restarting.title': 'Restarting…',
      'restarting.body': 'The window closes and reopens by itself. One moment.',
      'restarting.manual': 'If nothing happens within 30 seconds, start the app by hand.',
      'error.close': 'OK',
      'error.installing': 'A plugin is being installed; try again later.',
      'error.cooldown': 'Restarted just now; try again in {seconds}s.',
      'error.unauthorized': 'This page is not authenticated, so it cannot restart.',
      'error.forbidden': 'Restarting is disabled.',
      'error.reason': 'Restart failed: {reason}',
    };

    const CSS = [
      '.dshrb-root{--dshrb-accent:var(--bt-accent,var(--dsw-alias-brand-primary,#4d6bfe));',
      'position:fixed;right:calc(20px + env(safe-area-inset-right,0px));bottom:calc(20px + env(safe-area-inset-bottom,0px));',
      'z-index:900;display:flex;flex-direction:column;',
      'align-items:flex-end;gap:10px;pointer-events:auto;',
      'font-family:var(--bt-font,var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif));}',
      '.dshrb-root .dshrb-fab{width:36px;height:36px;padding:0;border:0;border-radius:50%;corner-shape:round;',
      'background:color-mix(in srgb,var(--bt-ink,var(--dsw-alias-label-primary,#141414)) 5%,var(--bt-sidebar,var(--bt-main,var(--dsw-alias-bg-base,#fcfcfc))));',
      'box-shadow:inset 0 0 0 1px var(--bt-line,var(--dsw-alias-border-l1,rgba(20,20,20,.08)));',
      'color:var(--bt-ink-2,color-mix(in srgb,var(--bt-ink,var(--dsw-alias-label-primary,#141414)) 60%,transparent));',
      'display:inline-flex;align-items:center;justify-content:center;cursor:pointer;',
      'outline:none;-webkit-tap-highlight-color:transparent;',
      'transition:background-color .12s ease,transform .12s ease,color .12s ease;}',
      '.dshrb-root .dshrb-fab:hover{background:color-mix(in srgb,var(--bt-ink,var(--dsw-alias-label-primary,#141414)) 9%,var(--bt-sidebar,var(--bt-main,var(--dsw-alias-bg-base,#fcfcfc))));color:var(--bt-ink,var(--dsw-alias-label-primary,#141414));}',
      '.dshrb-root .dshrb-fab:active{transform:scale(.94);}',
      '.dshrb-root .dshrb-fab:focus-visible{outline:2px solid var(--dshrb-accent);outline-offset:2px;}',
      '.dshrb-root .dshrb-fab[data-busy="true"]{cursor:default;color:var(--bt-ink-2,color-mix(in srgb,var(--bt-ink,#141414) 60%,transparent));}',
      '.dshrb-root .dshrb-fab[data-busy="true"] svg{animation:dshrb-spin .9s linear infinite;}',
      '@keyframes dshrb-spin{to{transform:rotate(360deg);}}',
      '.dshrb-root .dshrb-card{width:256px;box-sizing:border-box;padding:14px;border-radius:12px;',
      'background:var(--bt-glass-bg,var(--dsw-alias-bg-overlay,#fff));',
      'color:var(--bt-ink,var(--dsw-alias-label-primary,#141414));',
      '-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%);',
      'border:.5px solid var(--bt-glass-rim,var(--dsw-alias-border-l1,rgba(20,20,20,.09)));',
      'box-shadow:var(--bt-glass-shadow,0 8px 28px -6px rgba(0,0,0,.18));',
      'font-size:13px;line-height:1.55;animation:dshrb-in .14s ease-out;}',
      '@keyframes dshrb-in{from{opacity:0;transform:translateY(4px);}}',
      '.dshrb-root .dshrb-card-title{font-weight:600;font-size:13px;margin:0 0 4px;}',
      '.dshrb-root .dshrb-card-text{margin:0;color:var(--bt-ink-2,var(--dsw-alias-label-secondary,rgba(20,20,20,.6)));',
      'font-size:12px;line-height:1.6;}',
      '.dshrb-root .dshrb-actions{display:flex;justify-content:flex-end;align-items:center;gap:6px;margin-top:12px;flex-wrap:wrap;}',
      '.dshrb-root .dshrb-btn{appearance:none;border:0;background:none;color:inherit;font:inherit;font-size:13px;',
      'height:30px;padding:0 12px;border-radius:999px;corner-shape:round;cursor:pointer;',
      'transition:background-color .12s ease;}',
      '.dshrb-root .dshrb-btn:hover{background:var(--bt-hover,rgba(119,119,119,.09));}',
      '.dshrb-root .dshrb-btn:focus-visible{outline:2px solid var(--dshrb-accent);outline-offset:1px;}',
      '.dshrb-root .dshrb-btn[data-variant="primary"]{background:var(--dshrb-accent);color:var(--bt-accent-ink,#fff);}',
      '.dshrb-root .dshrb-btn[data-variant="primary"]:hover{filter:brightness(.95);background:var(--dshrb-accent);}',
      '.dshrb-root .dshrb-btn[data-variant="danger"]{color:var(--bt-danger,var(--dsw-alias-state-error-primary,#e02135));}',
    ].join('');

    function prefersChinese() {
      try {
        const lang = String(document.documentElement.lang || navigator.language || '').toLowerCase();
        return lang.startsWith('zh');
      } catch (error) {
        return false;
      }
    }

    function fallbackTranslate(key, params) {
      const dict = prefersChinese() ? ZH : EN;
      let text = dict[key];
      if (text === undefined) text = EN[key];
      if (text === undefined) return key;
      if (!params) return text;
      return text.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match);
    }

    function RestartGlyph() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: 'false',
      },
        h('path', { d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8' }),
        h('path', { d: 'M21 3v5h-5' }));
    }

    function ActionRow({ children }) {
      return h('div', { className: 'dshrb-actions' }, children);
    }

    function ActionButton({ variant, onClick, children }) {
      return h('button', {
        type: 'button',
        className: 'dshrb-btn',
        'data-variant': variant || 'plain',
        onClick,
      }, children);
    }

    function RestartButton(props) {
      const service = props.service || null;
      const [ready, setReady] = useState(false);
      const [phase, setPhase] = useState('idle');
      const [info, setInfo] = useState({});
      const [stale, setStale] = useState(false);
      const [, setTick] = useState(0);
      const busyRef = useRef(false);
      const rootRef = useRef(null);
      const dialogRef = useRef(null);
      const fabRef = useRef(null);
      const prevPhaseRef = useRef('idle');

      const bound = useMemo(() => {
        if (!service || typeof service.bind !== 'function') return null;
        try { return service.bind(NS); } catch (error) { return null; }
      }, [service]);

      const t = useCallback((key, params) => {
        if (bound) {
          try {
            const text = bound(key, params);
            if (text && text !== key) return text;
          } catch (error) { /* fall through to the bundled copy */ }
        }
        return fallbackTranslate(key, params);
      }, [bound]);

      // Follow language switches made in Settings while the button is mounted.
      useEffect(() => {
        if (!service || typeof service.subscribe !== 'function') return undefined;
        return service.subscribe(() => setTick((n) => n + 1));
      }, [service]);

      // Mount wherever the restart route answers. The route itself refuses with
      // a typed reason when the environment cannot restart (browser tab, other
      // platform, disabled by config), and that reason is shown in the card, so
      // the button never silently does nothing. It stays hidden only when the
      // route is absent — the plugin that owns the restart is not installed.
      useEffect(() => {
        let cancelled = false;
        fetch(PROBE, { method: 'GET', credentials: 'same-origin' })
          .then((response) => (response.ok ? response.json() : { status: response.status }))
          .then((body) => {
            if (cancelled || !body) return;
            if (body.status && body.status !== 200) return;
            setReady(true);
          })
          .catch(() => {});
        return () => { cancelled = true; };
      }, []);

      // The window closes and this page dies with the process; if that does not
      // happen the card says so instead of spinning forever.
      useEffect(() => {
        if (phase !== 'restarting' && phase !== 'waiting') { setStale(false); return undefined; }
        const timer = setTimeout(() => setStale(true), 30000);
        return () => clearTimeout(timer);
      }, [phase]);

      const reset = useCallback(() => {
        setPhase('idle');
        setInfo({});
        setStale(false);
      }, []);

      const dispatchRestart = useCallback((query) => {
        if (busyRef.current) return;
        busyRef.current = true;
        setPhase('sending');
        setInfo({});
        fetch(ACTION + (query || ''), { method: 'POST', credentials: 'same-origin' })
          .then(async (response) => {
            let body = {};
            try { body = await response.json(); } catch (error) { body = {}; }
            if (response.status === 202 && body.ok) {
              if (body.mode === 'waiting') {
                setPhase('waiting');
                setInfo({ tasks: body.tasks || 0 });
              } else {
                setPhase('restarting');
                setInfo({});
              }
              return;
            }
            if (response.status === 409) {
              if (body.reason === 'busy') {
                setPhase('busy');
                setInfo({ tasks: body.tasks || 0 });
                return;
              }
              if (body.reason === 'installing') {
                setPhase('error');
                setInfo({ key: 'error.installing' });
                return;
              }
              if (body.reason === 'cooldown') {
                setPhase('error');
                setInfo({ key: 'error.cooldown', seconds: Math.max(1, Math.ceil((body.retryAfterMs || 0) / 1000)) });
                return;
              }
            }
            if (response.status === 401) {
              setPhase('error');
              setInfo({ key: 'error.unauthorized' });
              return;
            }
            if (response.status === 403) {
              setPhase('error');
              setInfo({ key: 'error.forbidden' });
              return;
            }
            setPhase('error');
            setInfo({ key: 'error.reason', reason: body.reason || ('HTTP ' + response.status) });
          })
          .catch(() => {
            // The page usually dies with the process, so a rejected request is
            // the expected outcome of a restart that is already under way.
            setPhase('restarting');
            setInfo({});
          })
          .then(() => { busyRef.current = false; });
      }, []);

      const cancelWaiting = useCallback(() => {
        fetch(ACTION + '?cancel=1', { method: 'POST', credentials: 'same-origin' })
          .catch(() => {})
          .then(() => reset());
      }, [reset]);

      // A restart that never happens leaves the card on screen; once the hint
      // shows up the user must be able to put the card away again.
      const closable = phase === 'confirm' || phase === 'busy' || phase === 'waiting'
        || phase === 'error' || (phase === 'restarting' && stale);

      useEffect(() => {
        if (!closable) return undefined;
        const onKey = (event) => { if (event.key === 'Escape') reset(); };
        const onDown = (event) => {
          const root = rootRef.current;
          if (!root || !event.target || !root.contains(event.target)) reset();
        };
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('pointerdown', onDown, true);
        return () => {
          window.removeEventListener('keydown', onKey, true);
          window.removeEventListener('pointerdown', onDown, true);
        };
      }, [closable, reset]);

      // Keyboard users land inside the card when it opens and back on the
      // button when it closes, so the corner control stays reachable without a
      // mouse and Escape never strands focus inside a vanished card.
      useEffect(() => {
        const previous = prevPhaseRef.current;
        prevPhaseRef.current = phase;
        if (closable) {
          const first = dialogRef.current ? dialogRef.current.querySelector('.dshrb-btn') : null;
          if (first && typeof first.focus === 'function') first.focus();
          return undefined;
        }
        if (phase === 'idle' && previous !== 'idle' && fabRef.current && typeof fabRef.current.focus === 'function') {
          fabRef.current.focus();
        }
        return undefined;
      }, [phase, closable]);

      const onFabClick = useCallback(() => {
        if (phase === 'idle') setPhase('confirm');
        else if (closable) reset();
      }, [phase, closable, reset]);

      let card = null;
      if (phase === 'confirm') {
        card = h('div', { className: 'dshrb-card', role: 'dialog', ref: dialogRef, 'aria-label': t('fab.label') },
          h('p', { className: 'dshrb-card-title' }, t('confirm.title')),
          h('p', { className: 'dshrb-card-text' }, t('confirm.body')),
          h(ActionRow, null,
            h(ActionButton, { onClick: reset }, t('confirm.cancel')),
            h(ActionButton, { variant: 'primary', onClick: () => dispatchRestart('') }, t('confirm.ok'))));
      } else if (phase === 'busy') {
        card = h('div', { className: 'dshrb-card', role: 'dialog', ref: dialogRef, 'aria-label': t('fab.label') },
          h('p', { className: 'dshrb-card-title' }, t('busy.title')),
          h('p', { className: 'dshrb-card-text' }, t('busy.body', { tasks: info.tasks || 0 })),
          h(ActionRow, null,
            h(ActionButton, { onClick: reset }, t('busy.cancel')),
            h(ActionButton, { onClick: () => dispatchRestart('?wait=1') }, t('busy.wait')),
            h(ActionButton, { variant: 'danger', onClick: () => dispatchRestart('?force=1') }, t('busy.force'))));
      } else if (phase === 'waiting') {
        card = h('div', { className: 'dshrb-card', role: 'dialog', ref: dialogRef, 'aria-label': t('fab.label') },
          h('p', { className: 'dshrb-card-title' }, t('waiting.title')),
          h('p', { className: 'dshrb-card-text' }, t('waiting.body', { tasks: info.tasks || 0 })),
          h(ActionRow, null, h(ActionButton, { onClick: cancelWaiting }, t('waiting.cancel'))));
      } else if (phase === 'restarting') {
        card = h('div', { className: 'dshrb-card', role: 'dialog', ref: dialogRef, 'aria-label': t('fab.label') },
          h('p', { className: 'dshrb-card-title' }, t('restarting.title')),
          h('p', { className: 'dshrb-card-text' }, stale ? t('restarting.manual') : t('restarting.body')),
          stale ? h(ActionRow, null, h(ActionButton, { onClick: reset }, t('error.close'))) : null);
      } else if (phase === 'error') {
        card = h('div', { className: 'dshrb-card', role: 'dialog', ref: dialogRef, 'aria-label': t('fab.label') },
          h('p', { className: 'dshrb-card-text' }, t(info.key || 'error.reason', info)),
          h(ActionRow, null, h(ActionButton, { onClick: reset }, t('error.close'))));
      }

      const spinning = phase === 'sending' || phase === 'restarting';

      return h('div', { className: 'dshrb-root', ref: rootRef, 'data-phase': phase },
        h('style', null, CSS),
        card,
        h('button', {
          type: 'button',
          className: 'dshrb-fab',
          ref: fabRef,
          'data-busy': spinning ? 'true' : 'false',
          'aria-label': t('fab.label'),
          title: t('fab.hint'),
          onClick: onFabClick,
        }, h(RestartGlyph)));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.inject(['slots', 'locale'], (scope) => {
          const service = (scope.get ? scope.get('locale') : null) || ctx.get('locale') || null;
          if (service && typeof service.register === 'function') {
            ctx.effect(() => {
              try { return service.register(NS, { zh: ZH, en: EN }); } catch (error) { return undefined; }
            }, 'dsh-bot-restart-btn: dictionaries');
          }
          const options = { name: 'shell.overlay', id: 'dsh-bot-restart-btn', order: 900 };
          if (service) options.locale = NS;
          scope.slots.inject('shell.overlay', () =>
            scope.slots.register(options, (slotProps) =>
              h(RestartButton, Object.assign({}, slotProps, { service: service || slotProps.service }))));
        });
      },
    };
  },
});
