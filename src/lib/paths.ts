const base = import.meta.env.BASE_URL.replace(/\/$/, '');

export function publicPath(path: string): string {
  return `${base}/${path.replace(/^\//, '')}`;
}

export const BUSYTEX_BASE_PATH = publicPath('core/busytex');

export const BUSYTEX_DATA_PACKAGES = {
  extra: `${BUSYTEX_BASE_PATH}/texlive-extra.js`
} as const;
