import React from 'react';
import ReactDOM from 'react-dom/client';
// Global tokens + primitives first, so component modules can refine them.
import './index.css';
import App from './App.tsx';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
