/** Isolated preview of an AI-made file in the Results tab (desktop only; see src/main/artifact-preview.ts). */
export type ArtifactPreviewKind = 'html' | 'pdf';

export type ArtifactGrantResult =
  | { readonly ok: true; readonly token: string; readonly url: string }
  | { readonly ok: false; readonly error: 'invalid-path' | 'not-found' | 'unsupported' | 'too-large' };
