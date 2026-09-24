export const DEMO_CONFIG_KEY = 'vq-demo-config';
export const DEMO_SESSION_KEY = 'vq-demo-session';

export function readJson<T>(key: string, fallback: T): T {
  try {
    const item = localStorage.getItem(key);
    return item ? JSON.parse(item) as T : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* localStorage is optional in private/demo previews */
  }
}

export function normalizeWebsite(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^https?:\/\/\S+$/i.test(trimmed)) return trimmed;
  if (/^[\w][\w.-]*\.[A-Za-z]{2,}([/:?#]\S*)?$/i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The room photo could not be loaded for a preview redesign.'));
    image.src = url;
  });
}

export async function mockRedesign(imageUrl: string, brief: string): Promise<string> {
  const image = await loadImage(imageUrl);
  const width = Math.min(image.naturalWidth || 1400, 1400);
  const height = Math.round((image.naturalHeight || 900) * (width / (image.naturalWidth || 1400)));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot create a preview redesign.');
  ctx.drawImage(image, 0, 0, width, height);
  const cool = /coastal|modern|white|cool|minimal|scandi/i.test(brief);
  const pixels = ctx.getImageData(0, 0, width, height);
  const data = pixels.data;
  for (let index = 0; index < data.length; index += 4) {
    if (cool) {
      data[index] = Math.min(255, data[index] * 0.9 + 10);
      data[index + 1] = Math.min(255, data[index + 1] * 1.03 + 8);
      data[index + 2] = Math.min(255, data[index + 2] * 1.1 + 16);
    } else {
      data[index] = Math.min(255, data[index] * 1.08 + 16);
      data[index + 1] = Math.min(255, data[index + 1] * 1.02 + 6);
      data[index + 2] = Math.min(255, data[index + 2] * 0.88);
    }
  }
  ctx.putImageData(pixels, 0, 0);
  ctx.fillStyle = cool ? 'rgba(18, 52, 64, 0.78)' : 'rgba(48, 28, 16, 0.78)';
  ctx.fillRect(0, height - 54, width, 54);
  ctx.fillStyle = '#fff8ee';
  ctx.font = '600 18px sans-serif';
  ctx.fillText(cool ? 'Coastal concept · visual study' : 'Warm concept · visual study', 20, height - 22);
  return canvas.toDataURL('image/jpeg', 0.86);
}
