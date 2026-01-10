/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      animation: {
        'float-0': 'float 6s ease-in-out infinite',
        'float-1000': 'float 6s ease-in-out 1s infinite',
        'float-2000': 'float 6s ease-in-out 2s infinite',
        'float-500': 'float 6s ease-in-out 0.5s infinite',
        'float-1500': 'float 6s ease-in-out 1.5s infinite',
        'float-2500': 'float 6s ease-in-out 2.5s infinite',
        'float-3000': 'float 6s ease-in-out 3s infinite',
        'shimmer': 'shimmer 2s linear infinite',
        'shake': 'shake 0.5s cubic-bezier(.36,.07,.19,.97) both',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-20px)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        shake: {
          '10%, 90%': { transform: 'translate3d(-1px, 0, 0)' },
          '20%, 80%': { transform: 'translate3d(2px, 0, 0)' },
          '30%, 50%, 70%': { transform: 'translate3d(-4px, 0, 0)' },
          '40%, 60%': { transform: 'translate3d(4px, 0, 0)' },
        }
      }
    },
  },
  plugins: [],
}
