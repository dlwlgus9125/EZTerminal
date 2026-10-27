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
  // Android set (I4): the phone's screens move off lucide onto the same stencil grid.
  plus: 'M8.75 3h2.5v5.75H17v2.5h-5.75V17h-2.5v-5.75H3v-2.5h5.75z',
  minus: 'M3 8.75h14v2.5H3z',
  info: 'M10 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16zm-1.25 7v5.5h2.5V9zm0-3.5V8h2.5V5.5z',
  next: 'M7.5 3.5L14 10l-6.5 6.5L6 15l5-5-5-5z',
  up: 'M3.5 12.5L10 6l6.5 6.5L15 14l-5-5-5 5z',
  down: 'M3.5 7.5L10 14l6.5-6.5L15 6l-5 5-5-5z',
  check: 'M16 4.6l1.6 1.5L8 16l-5.6-5.6L4 8.9l4 4z',
  refresh: 'M10 3A7 7 0 1 0 16.06 6.5L14.11 7.63A4.75 4.75 0 1 1 10 5.25zM10 1l3.5 3.12L10 7.25z',
  trash: 'M7.5 2h5v1.5H17v2H3v-2h4.5zM4.5 7h11l-1 10.25a1 1 0 0 1-1 .75h-7a1 1 0 0 1-1-.75zm3 2.5v6H9v-6zm3.5 0v6h1.5v-6z',
  warn: 'M10 2l8.5 15a.75.75 0 0 1-.65 1H2.15a.75.75 0 0 1-.65-1zM9 7.5v5h2v-5zm0 6.5v2h2v-2z',
  stop: 'M5 4h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
  download: 'M8.75 2h2.5v7.5l2.6-2.6 1.75 1.75L10 14.3 4.4 8.65l1.75-1.75 2.6 2.6zM2 15h16v3H2z',
  upload: 'M10 2l5.6 5.65-1.75 1.75-2.6-2.6V14h-2.5V6.8l-2.6 2.6L4.4 7.65zM2 15h16v3H2z',
  qr: 'M2 2h7v7H2zm2 2v3h3V4zm1 1h1v1H5zM11 2h7v7h-7zm2 2v3h3V4zm1 1h1v1h-1zM2 11h7v7H2zm2 2v3h3v-3zm1 1h1v1H5zM11 11h3v3h-3zm4 0h3v3h-3zm-4 4h3v3h-3zm4 0h3v3h-3z',
  palette: 'M10 2a8 8 0 1 0 0 16h1a1.5 1.5 0 0 0 1.06-2.56 1.5 1.5 0 0 1 1.06-2.56H15a3 3 0 0 0 3-3C18 5.6 14.4 2 10 2zM4.75 10a1.25 1.25 0 1 0 2.5 0 1.25 1.25 0 1 0-2.5 0zm1.5-4a1.25 1.25 0 1 0 2.5 0 1.25 1.25 0 1 0-2.5 0zm4-.5a1.25 1.25 0 1 0 2.5 0 1.25 1.25 0 1 0-2.5 0zm3.5 2.5a1.25 1.25 0 1 0 2.5 0 1.25 1.25 0 1 0-2.5 0z',
  eye: 'M10 4c4 0 7 3 8.5 6-1.5 3-4.5 6-8.5 6s-7-3-8.5-6C3 7 6 4 10 4zm0 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  eyeOff: 'M10 4c4 0 7 3 8.5 6-1.5 3-4.5 6-8.5 6s-7-3-8.5-6C3 7 6 4 10 4zm0 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM3.4 2.3l14.3 14.3-1.1 1.1L2.3 3.4z',
  link: 'M8.5 6.5h-3a3.5 3.5 0 0 0 0 7h3v-2h-3a1.5 1.5 0 0 1 0-3h3zm3 0h3a3.5 3.5 0 0 1 0 7h-3v-2h3a1.5 1.5 0 0 0 0-3h-3zM7 9h6v2H7z',
  key: 'M6 5.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zm0 2.75a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5zM10.5 9H18v2h-1.5v2.5h-2V11h-1.25v2h-2v-2h-.75z',
  grip: 'M7 3h2.5v2.5H7zm3.5 0H13v2.5h-2.5zM7 8.75h2.5v2.5H7zm3.5 0H13v2.5h-2.5zM7 14.5h2.5V17H7zm3.5 0H13V17h-2.5z',
  merge: 'M3 2h4v4H3zm1.25 4h1.5v8h-1.5zM3 14h4v4H3zm2.75-6.5c0 2.2 1.8 3.5 4 3.5H13v1.5H9.75c-1.6 0-3-.6-4-1.6zM13 9.5h4v4h-4z',
  archive: 'M2 3h16v4H2zm1 5h14v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zm4.5 2v1.75h5V10z',
  clock: 'M10 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16zm-1 3.5V11l4 2.5.9-1.5-2.9-1.8V5.5z',
  more: 'M3 8.5h3v3H3zm5.5 0h3v3h-3zm5.5 0h3v3h-3z',
  enter: 'M15 3h2.5v8a1.5 1.5 0 0 1-1.5 1.5H7.4l2.6 2.6-1.75 1.75-5.6-5.6 5.6-5.6L10 7.4 7.4 10H15z',
  list: 'M2 3.5h2.5V6H2zm4 0h12V6H6zM2 8.75h2.5v2.5H2zm4 0h12v2.5H6zM2 14h2.5v2.5H2zm4 0h12v2.5H6z',
  grid: 'M2 2h7v7H2zm9 0h7v7h-7zM2 11h7v7H2zm9 0h7v7h-7z',
  home: 'M10 2l8 7h-2.5v8a1 1 0 0 1-1 1H12v-5H8v5H5.5a1 1 0 0 1-1-1V9H2z',
  pc: 'M2 3h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-6v2h3v2H5v-2h3v-2H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm1 2v7h14V5z',
  // Android set, second pass (I4-11): the agent list, PC Control and the terminal's own controls.
  play: 'M5.5 3l11 7-11 7z',
  globe: 'M10 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16zm-1.4 2.2A6 6 0 0 0 4.1 9h2.95c.15-1.9.7-3.55 1.55-4.8zm2.8 0c.85 1.25 1.4 2.9 1.55 4.8h2.95a6 6 0 0 0-4.5-4.8zM9.05 9h1.9c-.15-1.55-.5-2.75-.95-3.55-.45.8-.8 2-.95 3.55zM4.1 11a6 6 0 0 0 4.5 4.8c-.85-1.25-1.4-2.9-1.55-4.8zm4.95 0c.15 1.55.5 2.75.95 3.55.45-.8.8-2 .95-3.55zm3.9 0c-.15 1.9-.7 3.55-1.55 4.8a6 6 0 0 0 4.5-4.8z',
  server: 'M3 2h14a1 1 0 0 1 1 1v5H2V3a1 1 0 0 1 1-1zm1.5 2.5V6H7V4.5zM2 10h16v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1zm2.5 2.5V14H7v-1.5z',
  keyboard: 'M2 5h16a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1.5 2.5V9H5V7.5zm3 0V9H8V7.5zm3 0V9H11V7.5zm3 0V9H14V7.5zm3 0V9H17V7.5zM5 11v1.5h10V11z',
  pointer: 'M4 2l12.5 7.5-5.25 1.5 3.25 5.5-2.2 1.25-3.2-5.5L5.4 16.5z',
  touchpad: 'M3 3h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm1.5 2v7h11V5zm0 8.5V15h5v-1.5zm6 0V15h5v-1.5z',
  expand: 'M2 2h6v2.5H4.5V8H2zm10 0h6v6h-2.5V4.5H12zM2 12h2.5v3.5H8V18H2zm13.5 0H18v6h-6v-2.5h3.5z',
  power: 'M8.75 2h2.5v8h-2.5zM5.4 4.3L7 6.2a5 5 0 1 0 6 0l1.6-1.9a7.5 7.5 0 1 1-9.2 0z',
  copy: 'M6 2h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-1.5V4.5H6zM3 6h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zm1.5 2.5v7h6v-7z',
  paste: 'M7.5 2h5v1.5H16a1 1 0 0 1 1 1V17a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1h3.5zm-2 4v9.5h9V6h-1.5v1.5h-6V6z',
  offline: 'M10 13.5a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5zM10 4a11 11 0 0 1 8 3.4l-1.8 1.8A8.5 8.5 0 0 0 10 6.5a8.5 8.5 0 0 0-6.2 2.7L2 7.4A11 11 0 0 1 10 4zM3.4 2.3l14.3 14.3-1.1 1.1L2.3 3.4z',
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

/** Every glyph name, in declaration order (the gallery story and tests walk it). */
export const GLYPH_NAMES = Object.keys(PATHS) as readonly GlyphName[];

/** Icon-component props: the glyph is always decorative, so `aria-hidden` is accepted and implied. */
export interface GlyphIconProps {
  readonly className?: string;
  readonly 'aria-hidden'?: boolean | 'true' | 'false';
  /** Pixel size (the glyph's 20px grid scales); 18 by default. */
  readonly size?: number;
}

const glyphIcons = new Map<GlyphName, (props: GlyphIconProps) => JSX.Element>();

/**
 * A glyph shaped like an icon component, for primitives that take an icon component
 * (`IconButton icon={glyphIcon('back')}`). One stable component per name.
 */
export function glyphIcon(name: GlyphName): (props: GlyphIconProps) => JSX.Element {
  let icon = glyphIcons.get(name);
  if (!icon) {
    icon = function GlyphIcon(props: GlyphIconProps) {
      return <Glyph name={name} className={props.className} {...(props.size !== undefined ? { size: props.size } : {})} />;
    };
    glyphIcons.set(name, icon);
  }
  return icon;
}

export type LedTone = 'on' | 'amber' | 'red' | 'ok' | 'idle';

/** A panel lamp. The state it shows is always also written next to it. */
export function Led({ tone }: { readonly tone: LedTone }): JSX.Element {
  return <span className="ez-ui-led" data-tone={tone} aria-hidden="true" />;
}
