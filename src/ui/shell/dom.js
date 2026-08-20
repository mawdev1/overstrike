export function appendChildren(parent, children) {
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function element(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'className') node.className = String(value);
    else if (name === 'text') node.textContent = String(value);
    else if (name === 'dataset') Object.assign(node.dataset, value);
    else if (name === 'on') {
      for (const [eventName, handler] of Object.entries(value)) node.addEventListener(eventName, handler);
    } else if (name in node && !name.startsWith('aria-') && !name.startsWith('data-')) {
      node[name] = value;
    } else {
      node.setAttribute(name, value === true ? '' : String(value));
    }
  }
  return appendChildren(node, children);
}

export function shellLink(label, href, attributes = {}) {
  return element('a', { href, 'data-shell-link': 'true', ...attributes }, label);
}

export function actionButton(label, onClick, attributes = {}) {
  return element('button', { type: 'button', ...attributes, on: { click: onClick, ...(attributes.on || {}) } }, label);
}

export function field({ label, name, type = 'text', autocomplete, required = false, hint, min, max }) {
  const input = element('input', { id: `shell-${name}`, name, type, autocomplete, required, min, max });
  const wrapper = element('div', { className: 'os-field' }, [
    element('label', { htmlFor: input.id }, label),
    input,
  ]);
  if (hint) wrapper.append(element('p', { className: 'os-hint', id: `${input.id}-hint` }, hint));
  if (hint) input.setAttribute('aria-describedby', `${input.id}-hint`);
  return { wrapper, input };
}

export function definitionList(entries) {
  const list = element('dl', { className: 'os-facts' });
  for (const [label, value] of entries) {
    list.append(element('div', {}, [element('dt', {}, label), element('dd', {}, value ?? 'Not available')]));
  }
  return list;
}

export function safeError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : null,
    message: typeof error?.message === 'string' && error.message.trim()
      ? error.message
      : 'The request could not be completed.',
  };
}
