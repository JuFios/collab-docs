/**
 * Puts text on the clipboard and says whether it worked. The Clipboard API exists only in a secure context (HTTPS
 * or localhost) and only while the page may use it, so a page served over plain HTTP, such as a staging host, or a
 * browser that refuses, falls back to copying from a selected field.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // refused (permission, or the page is not focused): try the fallback
  }
  return copyFromSelection(text);
}

function copyFromSelection(text: string): boolean {
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.setAttribute('aria-hidden', 'true');
  field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  // a dialog keeps focus inside itself, so the field has to live there to be selected
  const host = document.activeElement?.closest('[role="dialog"]') ?? document.body;
  const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  host.append(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  field.remove();
  restore?.focus();
  return copied;
}
