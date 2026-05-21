export const animeTheme = {
  duck: '#ffd86b',
  duckShadow: '#f6a84f',
  blush: '#ff8bb3',
  candy: '#ff7ab6',
  mint: '#7fe7c4',
  sky: '#8cc8ff',
  lavender: '#b7a8ff',
  cream: '#fff0b8',
  textDim: '#8f9ab7',
  danger: '#ff6b8f'
} as const

export type AnimeThemeColor = keyof typeof animeTheme
