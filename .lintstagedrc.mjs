export default {
  // Run ESLint on TypeScript files
  '**/*.{ts,tsx}': ['eslint --fix'],

  // Run Prettier on all supported files
  '**/*.{js,jsx,ts,tsx,json,md}': ['prettier --write'],

  // Run TypeScript compiler check on TypeScript files
  '**/*.{ts,tsx}': () => 'tsc --noEmit',
};
