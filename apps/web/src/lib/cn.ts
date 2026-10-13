import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Class names with Tailwind conflict resolution (later classes win). */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
