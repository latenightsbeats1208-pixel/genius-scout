const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const delay = {
  short: () => sleep(800 + Math.random() * 700),
  medium: () => sleep(1500 + Math.random() * 1500),
  long: () => sleep(3000 + Math.random() * 2000),
  api: () => sleep(400 + Math.random() * 200),
};
