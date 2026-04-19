import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

// 앱 루트 요소 생성
const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

// 전역 스타일 동적 생성 및 적용
const style = document.createElement('style');
style.textContent = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif; }
  #root { width: 100%; height: auto; min-height: 100vh; display: flex; justify-content: center; background: linear-gradient(135deg, #667EEA 0%, #764BA2 100%); }
  .page { width: 100%; display: flex; justify-content: center; padding: 20px; }
  .app-shell { width: 100%; max-width: 600px; background: white; border-radius: 20px; padding: 30px; box-shadow: 0 10px 40px rgba(0,0,0,0.2); }
`;
document.head.appendChild(style);

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);


