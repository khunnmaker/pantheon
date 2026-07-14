/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}', '../packages/pantheon-ui/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Apple-inspired type + palette. Inter (Latin) + Noto Sans Thai cover both scripts;
      // the SF/system stack wins on Apple devices for the native look.
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', '"Noto Sans Thai"', 'system-ui', 'sans-serif'],
        serif: ['Fraunces', '"Noto Sans Thai"', 'Georgia', 'serif'],
      },
      colors: {
        ink: '#1E2D2B', cream: '#FBF7F1', sand: '#F4EBDC', surface: '#FFFFFF',
        teal: '#1B92D1', teald: '#1473A8', teall: '#E6F3FB',
        coral: '#FF7A59', corald: '#F0613C', corall: '#FFEDE6',
        muted: '#5F706D', line: '#ECE2D3',
        // back-compat aliases (old utility names → current palette)
        subtle: '#5F706D', hair: '#ECE2D3', mist: '#F4EBDC',
        link: '#1473A8', brandblue: '#1B92D1',
      },
    },
  },
  plugins: [],
};
