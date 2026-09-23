import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import RiffMaster from '../riff-master.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RiffMaster />
  </StrictMode>
);
