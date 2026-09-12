import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import PodcastMoodMatcher from '../podcast-mood-matcher.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <PodcastMoodMatcher />
  </StrictMode>
);
