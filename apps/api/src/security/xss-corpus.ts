/**
 * What an attacker types into a document, a title or a comment. The same list goes through every path that shows
 * user content to somebody else (published page, version preview, search snippet, email), so that none of them
 * can fall behind the sanitiser.
 */
export const HOSTILE_TEXT = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><svg/onload=alert(1)>',
  "'><iframe src=javascript:alert(1)>",
  '</textarea><script>alert(1)</script>',
  '<a href="javascript:alert(1)">click</a>',
  '<style>@import url(//evil.example/x.css)</style>',
  '<meta http-equiv="refresh" content="0;url=//evil.example">',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  '{{constructor.constructor("alert(1)")()}}',
  '${alert(1)}',
  '‮<script>‭alert(1)',
  '\u0000<script>alert(1)</script>',
] as const;

/** Targets of a link that a browser would run or that leak the page to somebody else. */
export const HOSTILE_HREFS = [
  'javascript:alert(1)',
  ' JaVaScRiPt:alert(1)',
  'java\tscript:alert(1)',
  '\u0001javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  '//evil.example/x',
] as const;

/** Elements of a document the schema has no place for. */
export const HOSTILE_NODES = [
  'script',
  'iframe',
  'object',
  'embed',
  'style',
  'svg',
  'form',
] as const;

/** Attributes that run code or reach out when a browser sees them. */
export const HOSTILE_ATTRIBUTES: Record<string, string> = {
  onerror: 'alert(1)',
  onclick: 'alert(1)',
  onload: 'alert(1)',
  style: 'background:url(javascript:alert(1))',
  srcdoc: '<script>alert(1)</script>',
  formaction: 'javascript:alert(1)',
};
