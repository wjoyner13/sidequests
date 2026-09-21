import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import FintechDigest from '../fintech-digest.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <FintechDigest />
  </StrictMode>
);
