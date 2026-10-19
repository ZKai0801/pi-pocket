// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderChatMarkdown } from '../../src/chat/markdown';

describe('renderChatMarkdown', () => {
  it('renders emphasis and a fenced code block', () => {
    const html = renderChatMarkdown('**hi**\n\n```sh\nls -la\n```');
    expect(html).toContain('<strong>hi</strong>');
    expect(html).toContain('<code');
  });

  it('drops raw html from the source', () => {
    expect(renderChatMarkdown('<img src=x onerror=alert(1)>')).not.toContain('onerror');
  });

  it('strips script nodes and event handlers', () => {
    const html = renderChatMarkdown('<script>alert(1)</script><b onclick="x()">b</b>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
  });

  it('neutralises a javascript: link', () => {
    expect(renderChatMarkdown('[x](javascript:alert(1))')).not.toContain('javascript:');
  });
});
