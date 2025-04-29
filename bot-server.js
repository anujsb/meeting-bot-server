const express = require('express');
const puppeteer = require('puppeteer');
const { AssemblyAI } = require('assemblyai');

const app = express();
app.use(express.json());

// Store active meeting sessions
const sessions = new Map();

app.post('/join', async (req, res) => {
  const { sessionId, meetingUrl } = req.body;
  if (!sessionId || !meetingUrl) {
    return res.status(400).json({ error: 'sessionId and meetingUrl are required' });
  }

  try {
    // Launch Puppeteer browser
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(meetingUrl, { waitUntil: 'networkidle2' });

    // Join the meeting (simplified from src/lib/googleMeet.ts)
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const button of buttons) {
        if (button.innerText.includes('Turn off camera') || button.innerText.includes('Turn off microphone')) {
          button.click();
        }
        if (button.innerText.includes('Join now') || button.innerText.includes('Join meeting')) {
          button.click();
        }
      }
    });
    await page.waitForSelector('[data-meeting-code]', { timeout: 60000 });

    // Inject Assembly AI SDK
    await page.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/assemblyai@latest/dist/assemblyai.umd.js' });

    // Capture audio and start transcription
    await page.evaluate((token) => {
      window.transcription = [];
      const audioContext = new AudioContext();
      const destination = audioContext.createMediaStreamDestination();
      const audioElements = document.querySelectorAll('audio');
      audioElements.forEach(el => {
        const source = audioContext.createMediaElementSource(el);
        source.connect(destination);
      });
      const mixedStream = destination.stream;
      const transcriber = new AssemblyAI.RealtimeTranscriber({ token });
      transcriber.on('transcript', (data) => {
        if (data.text) {
          window.transcription.push({
            text: data.text,
            speaker: data.speaker || 'Unknown',
            timestamp_start: data.start,
            timestamp_end: data.end
          });
        }
      });
      transcriber.start(mixedStream);
      window.transcriber = transcriber;
    }, process.env.ASSEMBLYAI_API_TOKEN);

    sessions.set(sessionId, { page, browser });
    res.json({ success: true, sessionId });
  } catch (error) {
    console.error('Error joining meeting:', error);
    res.status(500).json({ error: 'Failed to join meeting' });
  }
});

app.post('/leave', async (req, res) => {
  const { sessionId } = req.body;
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  try {
    // Retrieve transcription and stop transcriber
    const transcription = await session.page.evaluate(() => window.transcription || []);
    await session.page.evaluate(() => window.transcriber && window.transcriber.close());
    await session.page.close();
    await session.browser.close();
    sessions.delete(sessionId);

    // Compile full transcript and summary (simplified)
    const fullTranscript = transcription.map(t => t.text).join(' ');
    res.json({
      success: true,
      transcription: {
        transcript: fullTranscript,
        speakers: transcription,
        summary: fullTranscript.substring(0, 100) + '...' // Placeholder summary
      }
    });
  } catch (error) {
    console.error('Error leaving meeting:', error);
    res.status(500).json({ error: 'Failed to leave meeting' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Bot server running on port ${PORT}`));