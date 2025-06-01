# Roadmap React App

This React application allows you to upload an Excel file with the following columns:

- Category
- Feature
- StartDate
- EndDate
- ColorHex

It then renders a Gantt-style roadmap using Vis Timeline.

## Getting Started

1. Install dependencies:
   ```
   npm install
   ```
2. Start the development server:
   ```
   npm start
   ```
3. Open [http://localhost:3000](http://localhost:3000) in your browser.
4. Upload your Excel file to see the roadmap.

## Excel Format

The Excel file must contain a sheet named `RoadmapInput` (or the first sheet) with columns:
- Category (text)
- Feature (text)
- StartDate (date)
- EndDate (date)
- ColorHex (hex code, e.g. `#7E57C2`)

Save the file as `.xlsx` and upload via the file input in the app.
