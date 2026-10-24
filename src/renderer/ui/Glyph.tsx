/**
 * Stencil glyphs of the 2.0 Board + Desk language: filled silhouettes on a 20px grid with 2px
 * knock-outs (evenodd) and a 3px outer radius. Decorative: every use sits next to a visible
 * label or carries one through the control's accessible name. The shell, board, live list and
 * flow use these; lucide icons elsewhere are replaced bundle by bundle.
 */

const PATHS = {
  new: 'M3 3h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7l-4 3.5V14H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm6 3v2.5H6.5v2H9V13h2v-2.5h2.5v-2H11V6z',
  term: 'M3 3h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm2.5 4.5L8 10l-2.5 2.5L7 14l4-4-4-4zM10 12.5V14h5v-1.5z',
  proj: 'M2 4a1 1 0 0 1 1-1h5l2 2h7a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1zm2 4v6.5h12V8z',
  file: 'M5 2h7l4 4v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm2 8v1.5h6V10zm0 3.5V15h4.5v-1.5z',
  req: 'M4.5 4h11l2.5 7v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-5zm1.4 2L4 11h4l1 2h2l1-2h4l-1.9-5z',
  search: 'M8.5 2a6.5 6.5 0 0 1 5.2 10.4l4.2 4.2-1.4 1.4-4.2-4.2A6.5 6.5 0 1 1 8.5 2zm0 2.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  set: 'M2 4h3V2.5h2.5V7H5V5.5H2zm7.5 0H18v1.5H9.5zM2 9.25h9.5v1.5H2zM12.5 7.5H15V9h3v2h-3v1.5h-2.5zM2 14.5h3V13h2.5v4.5H5V16H2zm7.5 0H18V16H9.5z',
  diff: 'M2 3h7v14H2zm9 0h7v14h-7zM4 9.25v1.5h3v-1.5zm9 0v1.5h1.25V12h1.5v-1.25H17v-1.5h-1.25V8h-1.5v1.25z',
  flow: 'M2 3h6v5H2zm10 4.5h6v5h-6zM2 12h6v5H2zM8 5h2.75v4.25H12v1.5h-1.25V14.5H8V13h1.25V6.5H8z',
  phone: 'M5.5 2h7a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm1.5 2.5V14h4V4.5zM8 15.25v1.25h2v-1.25z',
  kids: 'M7 2h6v5h-2.25v2H16v4h1.5v5h-5v-5H14v-2H6v2h1.5v5h-5v-5H4V9h5.25V7H7z',
  ok: 'M10 1.5l7 2.5v5.5c0 4.2-3 7.2-7 9-4-1.8-7-4.8-7-9V4zm3.4 5.4L9 11.3 6.7 9 5.3 10.4 9 14.1l5.8-5.8z',
  q: 'M3 3h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7l-4 3.5V14H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm7 1.75A2.75 2.75 0 0 0 7.25 7.5h2a.75.75 0 1 1 1.1.66c-.9.47-1.35 1.1-1.35 2.09v.25h2v-.2c0-.3.15-.5.6-.75A2.75 2.75 0 0 0 10 4.75zM9 11.25v1.75h2v-1.75z',
  mon: 'M2 16h16v2H2zM2 11.5l4-5 3.5 3 4-6 4.5 5V14H2z',
  claw: 'M10 2c3.6 2.8 6 7.2 6 14v1.5h-2.5V16c0-4.5-1.3-7.8-3.5-10.3C7.8 8.2 6.5 11.5 6.5 16v1.5H4V16c0-6.8 2.4-11.2 6-14z',
  back: 'M12.5 3.5L6 10l6.5 6.5 1.5-1.5-5-5 5-5z',
  pin: 'M7 2h6v1.5l-1 1V9l3 3v1.5h-4.25V18h-1.5v-4.5H5V12l3-3V4.5l-1-1z',
  x: 'M5.4 4L10 8.6 14.6 4 16 5.4 11.4 10l4.6 4.6-1.4 1.4-4.6-4.6L5.4 16 4 14.6 8.6 10 4 5.4z',
  send: 'M9 17V7.4l-3.6 3.6L4 9.6 10 3.6l6 6-1.4 1.4L11 7.4V17z',
  wt: 'M4 2h2.5v6.2c1.4-1.3 3.4-1.7 5.3-2 1.6-.3 2.4-.7 2.6-1.7H13V2h4.5v2.5h-.6c-.3 2.9-2.4 3.6-4.7 4-2.6.4-5.6 1-5.7 4.4V18H4z',
} as const;

/** Extra shapes drawn on top of a path (the request and phone glyphs carry a signal dot). */
const DOTS: Partial<Record<GlyphName, readonly [number, number, number]>> = {
  req: [16, 3.5, 2.5],
  phone: [16.5, 3.5, 2.5],
};

export type GlyphName = keyof typeof PATHS;

export function Glyph({ name, size = 18, className }: { readonly name: GlyphName; readonly size?: number; readonly className?: string }): JSX.Element {
  const dot = DOTS[name];
  return (
    <svg className={className ? `ez-ui-glyph ${className}` : 'ez-ui-glyph'} width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path fillRule="evenodd" d={PATHS[name]} />
      {dot && <circle cx={dot[0]} cy={dot[1]} r={dot[2]} />}
    </svg>
  );
}

export type LedTone = 'on' | 'amber' | 'red' | 'ok' | 'idle';

/** A panel lamp. The state it shows is always also written next to it. */
export function Led({ tone }: { readonly tone: LedTone }): JSX.Element {
  return <span className="ez-ui-led" data-tone={tone} aria-hidden="true" />;
}
