export default {
  '*.{ts,tsx,js}': ['prettier --write', 'eslint --fix'],
  '*.{json,md,yml,yaml}': ['prettier --write'],
};
