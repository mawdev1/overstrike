import { actionButton, element, safeError } from './dom.js';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function createModalController({ layer, inertTarget, documentRef = document } = {}) {
  let active = null;
  let returnTarget = null;

  const close = ({ restoreFocus = true } = {}) => {
    if (!active) return;
    active.remove();
    active = null;
    inertTarget?.removeAttribute?.('inert');
    if (inertTarget && 'inert' in inertTarget) inertTarget.inert = false;
    if (restoreFocus && returnTarget?.isConnected) returnTarget.focus();
    returnTarget = null;
  };

  const open = ({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', onConfirm, onCancel, dismissible = true, opener } = {}) => {
    close({ restoreFocus: false });
    returnTarget = opener || documentRef.activeElement;
    const titleId = `os-dialog-title-${Date.now()}`;
    const panel = element('section', {
      className: 'os-dialog',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
    });
    panel.append(element('h2', { id: titleId }, title || 'Confirm action'));
    if (message) panel.append(element('p', {}, message));
    const errorStatus = element('p', { className: 'os-dialog__error', role: 'alert', tabIndex: -1 });
    panel.append(errorStatus);
    const controls = element('div', { className: 'os-actions' });
    if (dismissible) {
      controls.append(actionButton(cancelLabel, () => {
        close();
        onCancel?.();
      }, { className: 'os-button os-button--quiet' }));
    }
    controls.append(actionButton(confirmLabel, async () => {
      errorStatus.textContent = '';
      try {
        const result = await onConfirm?.();
        if (result !== false) close();
      } catch (error) {
        errorStatus.textContent = safeError(error).message;
        errorStatus.focus();
      }
    }, { className: 'os-button os-button--danger' }));
    panel.append(controls);
    active = element('div', { className: 'os-modal-layer' }, panel);
    layer.append(active);
    inertTarget?.setAttribute?.('inert', '');
    if (inertTarget && 'inert' in inertTarget) inertTarget.inert = true;

    active.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && dismissible) {
        event.preventDefault();
        close();
        onCancel?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...panel.querySelectorAll(FOCUSABLE)];
      if (!focusable.length) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && documentRef.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && documentRef.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    queueMicrotask(() => panel.querySelector(FOCUSABLE)?.focus?.() || panel.focus());
    return Object.freeze({ close });
  };

  return Object.freeze({ open, close, isOpen: () => Boolean(active), destroy: () => close({ restoreFocus: false }) });
}
