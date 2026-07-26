import * as crypto from "crypto";

export function generateRandomHexString(length: number): string {
  if (length % 2 !== 0) {
    throw new Error("Length must be an even number");
  }

  const numBytes = length / 2;
  const randomBytes = crypto.randomBytes(numBytes);
  return randomBytes.toString("hex");
}

export function getUseableDatesFromMs(ms: number) {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  return { days, hours, minutes, seconds };
}
