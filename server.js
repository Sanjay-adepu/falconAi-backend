const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const { fromPath } = require("pdf2pic");
const path=require("path");

const Jimp = require("jimp");
const multer = require("multer");
const PDFDocument = require("pdfkit");
const PptxGenJS = require("pptxgenjs");
const { exec } = require("child_process");

require("dotenv").config();
const Tesseract = require("tesseract.js");
const sizeOf = require("image-size");

 
const mammoth = require("mammoth");
const pptx2json = require("pptx2json");

 
const app = express();
app.use(cors({ origin: "http://localhost:5173", methods: ["GET", "POST"] }));
app.use(express.json());

// Ensure 'generated_ppts' folder exists
if (!fs.existsSync("./generated_ppts")) fs.mkdirSync("./generated_ppts");

const GOOGLE_GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;
if (!GOOGLE_GEMINI_API_KEY) {
    console.error("❌ Error: GOOGLE_GEMINI_API_KEY is missing in .env file.");
    process.exit(1);
}


const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent";



const upload = multer({ dest: "watermark/" });

// Ensure `watermark` folder exists
const WATERMARK_FOLDER = path.join(__dirname, "watermark");
if (!fs.existsSync(WATERMARK_FOLDER)) fs.mkdirSync(WATERMARK_FOLDER);

// ✅ Remove watermark from Image
app.post("/remove-watermark/image", upload.single("image"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No image file uploaded" });

        const imagePath = req.file.path;
        const image = await Jimp.read(imagePath);

        // Convert image to grayscale to detect watermark
        image.greyscale();

        // Apply blur to remove watermark
        image.blur(5);

        // Save processed image
        const outputPath = path.join(WATERMARK_FOLDER, `processed_${req.file.originalname}`);
        await image.writeAsync(outputPath);

        res.download(outputPath);
    } catch (error) {
        console.error("Image Watermark Removal Error:", error);
        res.status(500).json({ error: "Failed to process image" });
    }
});


// ✅ Remove watermark from PDF
app.post("/remove-watermark/pdf", upload.single("pdf"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No PDF file uploaded" });

        const pdfPath = req.file.path;
        const outputPath = path.join(WATERMARK_FOLDER, `processed_${req.file.originalname}`);
        const imageFolder = path.join(WATERMARK_FOLDER, "pdf_images");

        if (!fs.existsSync(imageFolder)) fs.mkdirSync(imageFolder);

        // Convert PDF to images
        const pdf2pic = fromPath(pdfPath, {
            density: 300, // DPI (Higher means better quality)
            savePath: imageFolder,
            format: "png", // Save as PNG
            width: 1240, // A4 width
            height: 1754, // A4 height
        });

        const images = await pdf2pic.bulk(-1); // Convert all pages

        if (images.length === 0) {
            return res.status(500).json({ error: "Failed to convert PDF to images" });
        }

        let extractedText = "";

        // Process each image with Tesseract OCR
        for (const image of images) {
            const { data } = await Tesseract.recognize(image.path, "eng");
            extractedText += data.text.replace(/(?:watermark|company name)/gi, "") + "\n\n";
        }

        // Create a new PDF without watermark text
        const doc = new PDFDocument();
        doc.pipe(fs.createWriteStream(outputPath));
        doc.text(extractedText, 100, 100);
        doc.end();

        res.download(outputPath);
    } catch (error) {
        console.error("PDF Watermark Removal Error:", error);
        res.status(500).json({ error: "Failed to process PDF" });
    }
});





// ✅ Remove watermark from PPT
app.post("/remove-watermark/ppt", upload.single("ppt"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No PPT file uploaded" });

        const pptPath = req.file.path;
        const slides = JSON.parse(fs.readFileSync(pptPath, "utf-8")); // Assume JSON format for simplicity
        let pptx = new PptxGenJS();

        slides.forEach((slide) => {
            let newSlide = pptx.addSlide();
            let cleanTitle = slide.title.replace(/(?:watermark|company name)/gi, "");
            let cleanContent = slide.content.map(text => text.replace(/(?:watermark|company name)/gi, ""));

            newSlide.addText(cleanTitle, { x: 1, y: 0.5, fontSize: 24, bold: true });
            newSlide.addText(cleanContent.join("\n"), { x: 1, y: 1.5, fontSize: 18 });
        });

        const outputPath = path.join(WATERMARK_FOLDER, `processed_${req.file.originalname}`);
        await pptx.writeFile(outputPath);

        res.download(outputPath);
    } catch (error) {
        console.error("PPT Watermark Removal Error:", error);
        res.status(500).json({ error: "Failed to process PPT" });
    }
});











app.post("/generate-content", async (req, res) => {
    try {
        const { videoTitle, videoKeywords, language } = req.body;

        if (!videoTitle) {
            return res.status(400).json({ error: "Video title is required." });
        }

        // Default to English if no language is specified
        const targetLanguage = language || "English";

        // AI Prompt with structured formatting
        const prompt = `
        Generate an engaging YouTube caption, SEO-optimized hashtags, and a detailed description for the following video in ${targetLanguage}:
        - **Title:** ${videoTitle}
        - **Keywords:** ${videoKeywords || "None"}

        Format (strictly follow this structure without additional formatting):
        Caption: [short catchy caption]
        Hashtags: [comma-separated hashtags]
        Description: [detailed SEO-friendly description]
        `;

        // Send request to Google Gemini API
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${GOOGLE_GEMINI_API_KEY}`,
            {
                contents: [{ parts: [{ text: prompt }] }]
            }
        );

        const aiResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!aiResponse) {
            return res.status(500).json({ error: "Failed to generate content." });
        }

        // Extract caption, hashtags, and description
        const captionMatch = aiResponse.match(/Caption:\s*(.*)/);
        const hashtagsMatch = aiResponse.match(/Hashtags:\s*(.*)/);
        const descriptionMatch = aiResponse.match(/Description:\s*([\s\S]*)/);

        const caption = captionMatch ? captionMatch[1].trim() : "";
        const hashtags = hashtagsMatch ? hashtagsMatch[1].trim() : "";
        const description = descriptionMatch ? descriptionMatch[1].trim() : "";

        res.json({ caption, hashtags, description });

    } catch (error) {
        console.error("Error generating content:", error);
        res.status(500).json({ error: "Internal server error." });
    }
});





app.get("/get-slides/:topic", (req, res) => {
  try {
    const topic = req.params.topic;
    const jsonPath = path.join(__dirname, "generated_ppts", `${topic.replace(/\s/g, "_")}.json`);

    if (!fs.existsSync(jsonPath)) {
      return res.status(404).json({ error: "No slides found for this topic" });
    }

    const slides = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    res.json({ success: true, slides });
  } catch (error) {
    console.error("Error fetching slides:", error.message);
    res.status(500).json({ error: "Failed to fetch slides" });
  }
});


// 🆕 Translation Endpoint
app.post("/translate", async (req, res) => {
  try {
    const { text, sourceLanguage, targetLanguage } = req.body;
    if (!text || !targetLanguage) {
      return res.status(400).json({ error: "Text and targetLanguage are required" });
    }

    // Constructing the prompt dynamically
    let prompt = `Translate the following text to ${targetLanguage}: ${text}`;
    if (sourceLanguage) {
      prompt = `Translate the following text from ${sourceLanguage} to ${targetLanguage}: ${text}`;
    }

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${GOOGLE_GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }]
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const translatedText = response?.data?.candidates?.[0]?.content?.parts?.[0]?.text || "Translation failed";
    res.json({ success: true, translatedText });

  } catch (error) {
    console.error("Translation Error:", error.message);
    res.status(500).json({ error: "Translation failed" });
  }
});




app.post("/update-slides", (req, res) => {
  try {
    const { topic, slides } = req.body;
    const jsonPath = path.join(__dirname, "generated_ppts", `${topic.replace(/\s/g, "_")}.json`);

    if (!slides || slides.length === 0) {
      return res.status(400).json({ error: "No slides to save" });
    }

    // Ensure all slides have theme, colors, and images
    const formattedSlides = slides.map((slide) => ({
      title: slide.title || "Untitled Slide",
      content: slide.content || [],
      theme: slide.theme || "#FFFFFF", // Default to white
      titleColor: slide.titleColor || "#000000", // Default to black
      contentColor: slide.contentColor || "#000000", // Default to black
      image: slide.image || null, // Can be null if no image
    }));

    // Save slides with all properties
    fs.writeFileSync(jsonPath, JSON.stringify(formattedSlides, null, 2), "utf-8");

    res.json({ success: true, message: "Slides updated successfully!" });
  } catch (error) {
    console.error("Error updating slides:", error.message);
    res.status(500).json({ error: "Failed to update slides" });
  }
});




// ✅ AI-Powered Search using Google Gemini
app.post("/ai-search", async (req, res) => {
    try {
        const { query } = req.body;
        if (!query) return res.status(400).json({ error: "Query is required" });

        const response = await axios.post(
            GEMINI_API_URL,
            { contents: [{ parts: [{ text: query }] }] },
            { headers: { "Content-Type": "application/json" }, params: { key: GOOGLE_GEMINI_API_KEY } }
        );

        const aiResponse = response?.data?.candidates?.[0]?.content?.parts?.[0]?.text || "No relevant information found.";
        res.json({ query, response: aiResponse });

    } catch (error) {
        console.error("AI Search Error:", error.message);
        res.status(500).json({ error: "Failed to fetch search results" });
    }
});


// ✅ Convert Speech to Text using Google Gemini
app.post("/speech-to-text", upload.single("audio"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No audio file uploaded" });

        const audioBuffer = fs.readFileSync(req.file.path);
        const base64Audio = audioBuffer.toString("base64");

        const transcript = await axios.post(GEMINI_API_URL, {
            contents: [{ parts: [{ text: "Convert this speech to text:", inline_data: { mime_type: "audio/wav", data: base64Audio } }] }]
        }, { headers: { "Content-Type": "application/json" }, params: { key: GOOGLE_GEMINI_API_KEY } });

        const text = transcript.data.candidates?.[0]?.content?.parts?.[0]?.text || "No text extracted.";
        res.json({ text });

    } catch (error) {
        console.error("Speech-to-text error:", error.message);
        res.status(500).json({ error: "Failed to process speech" });
    }
});


// ✅ Check Slides Before Downloading
app.get("/check-slides", (req, res) => {
    const topic = req.query.topic;
    const filePath = `./generated_ppts/${topic.replace(/\s/g, "_")}.json`;

    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "No slides found for this topic" });

    const slides = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    res.json({ topic, slides });
});


// ✅ Generate Slides using Google Gemini

// Function to parse Gemini AI response into structured slides
function parseGeminiResponse(responseText) {
    const slides = [];
    const slideSections = responseText.split("Slide ");

    slideSections.forEach((section) => {
        const match = section.match(/^(\d+):\s*(.+)/);
        if (match) {
            const title = match[2].trim();
            const contentLines = section
                .split("\n")
                .slice(1)
                .map(line => line.trim())
                .filter(line => line);

            // Escape backticks in code blocks to prevent syntax errors
            const formattedContent = contentLines.map(line => 
                line.includes("```") ? line.replace(/```/g, "\\`\\`\\`") : line
            );

            slides.push({ title, content: formattedContent });
        }
    });

    return slides.length ? { slides } : { error: "Invalid AI response format" };
}

// API Route to Generate PPT from Gemini AI


app.post("/generate-ppt", async (req, res) => {
    const { topic, slidesCount } = req.body;

    if (!topic || !slidesCount) {
        return res.status(400).json({ error: "Missing required fields: topic and slidesCount" });
    }

    // Detect if the topic is related to coding
    const isCodingTopic = ["Java", "Python", "JavaScript", "C++", "C#", "React", "Node.js"].some(lang => 
        topic.toLowerCase().includes(lang.toLowerCase())
    );

    let prompt;
    if (isCodingTopic) {
        prompt = `
Generate a PowerPoint presentation on **"${topic}"** with exactly ${slidesCount} slides.

### **Slide Structure**:
1. **Slide Title**: Format as "**Slide X: Title**".
2. **Explanation**: Provide clear, structured bullet points.
3. **Code Snippets**: Format code properly using **"${topic.toLowerCase()}"** syntax.

### **Example:**
---
#### **Slide 1: Introduction to ${topic}**
- ${topic} is a widely used programming language.
- It is used in web development, automation, and AI.

#### **Slide 2: Hello World Example**
**Explanation:**
- A simple program to print "Hello, World!" in ${topic}.

\`\`\`${topic.toLowerCase()}
public class Main {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }
}
\`\`\`

#### **Slide 3: Variables and Data Types**
**Explanation:**
- ${topic} supports multiple data types such as int, double, and boolean.

**Example Code:**
\`\`\`${topic.toLowerCase()}
int age = 25;
double price = 19.99;
boolean isAvailable = true;
\`\`\`

Ensure proper **formatting, clarity, and well-structured slides**.
`;
    } else {
        prompt = `
Generate a structured PowerPoint presentation on **"${topic}"** with exactly ${slidesCount} slides.

### **Slide Structure**:
1. **Slide Title**: Format as "**Slide X: Title**".
2. **Content**: Bullet points explaining key concepts in simple terms.

### **Example:**
---
#### **Slide 1: Introduction to ${topic}**
- Definition of ${topic}.
- Importance and real-world applications.

#### **Slide 2: Key Features**
- Feature 1: Explanation.
- Feature 2: Explanation.

Ensure the response **follows this structured format**.
        `;
    }

    try {
        const geminiResponse = await axios.post(`${GEMINI_API_URL}?key=${GOOGLE_GEMINI_API_KEY}`, {
            contents: [{ parts: [{ text: prompt }] }]
        });

        const aiText = geminiResponse.data.candidates?.[0]?.content?.parts?.[0]?.text || "";

        const formattedSlides = parseGeminiResponse(aiText);

        if (formattedSlides.error) {
            return res.status(500).json({ error: "Unexpected AI response. Please try again." });
        }

        return res.json(formattedSlides);
    } catch (error) {
        console.error("Error calling Gemini API:", error);
        return res.status(500).json({ error: "Failed to generate slides from AI." });
    }
});




// Generate and Download PDF
app.get("/download-pdf/:topic", (req, res) => {
    const topic = req.params.topic;
    const jsonPath = path.join(__dirname, "generated_ppts", `${topic.replace(/\s/g, "_")}.json`);

    if (!fs.existsSync(jsonPath)) {
        return res.status(404).json({ error: "No slides found for this topic" });
    }

    const slides = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const doc = new PDFDocument();
    const pdfPath = path.join(__dirname, "generated_ppts", `${topic.replace(/\s/g, "_")}.pdf`);

    doc.pipe(fs.createWriteStream(pdfPath));

    slides.forEach((slide, index) => {
        doc.fontSize(20).text(slide.title, { underline: true }).moveDown();
        slide.content.forEach((text) => doc.fontSize(14).text(text).moveDown());
        doc.addPage();
    });

    doc.end();
    res.download(pdfPath);
});




// Generate and Download PPT
app.get("/download-ppt/:topic", async (req, res) => {
    const topic = req.params.topic;
    const jsonPath = path.join(__dirname, "generated_ppts", `${topic.replace(/\s/g, "_")}.json`);

    if (!fs.existsSync(jsonPath)) {
        return res.status(404).json({ error: "No slides found for this topic" });
    }

    const slides = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    let pptx = new PptxGenJS();

    slides.forEach((slide) => {
        let slidePpt = pptx.addSlide();
        slidePpt.background = { color: slide.theme || "#FFFFFF" };

        // **Updated Layout**
        const titleX = 0.5, titleY = 0.3, titleW = "90%";
        const contentX = 0.5, contentY = 1.2, contentW = "70%", contentH = 3.5;
        const imageX = 7.5, imageY = 1.2, imageW = 2.5, imageH = 2.5;  // Adjusted to align properly

        // **Title - No Overlap**
        slidePpt.addText(slide.title, {
            x: titleX, y: titleY, w: titleW,
            fontSize: 26, bold: true,
            color: slide.titleColor || "#D63384",
            align: "left", fontFace: "Arial Black"
        });

        // **Content - Smaller Font, Expanded Width**
        let contentText = slide.content.join("\n");
        slidePpt.addText(contentText, {
            x: contentX, y: contentY, w: contentW, h: contentH,
            fontSize: 20,  // Reduced for better layout
            color: slide.contentColor || "#333333",
            fontFace: "Georgia",
            lineSpacing: 26, align: "left"
        });

        // **Image - Adjusted Alignment**
        if (slide.image) {
            slidePpt.addImage({
                path: slide.image,
                x: imageX, y: imageY, w: imageW, h: imageH
            });
        }
    });

    const pptPath = path.join(__dirname, "generated_ppts", `${topic.replace(/\s/g, "_")}.pptx`);
    await pptx.writeFile(pptPath);
    res.download(pptPath);
});


app.post("/solve-math", upload.single("image"), async (req, res) => {
    try {
        let problem = req.body.problem?.trim() || "";

        if (req.file) {
            // Perform OCR with preprocessing
            const { data: { text } } = await Tesseract.recognize(req.file.path, "eng", {
                tessedit_char_whitelist: "0123456789+-*/=()xX",
                oem: 1,  // Best mode for handwritten text
                psm: 6   // Assume a single block of text
            });

            problem = text.replace(/\s+/g, " ").trim();
            fs.unlinkSync(req.file.path); // Clean up the uploaded file
        }

        if (!problem) {
            return res.status(400).json({ error: "Math problem is required (text or image)." });
        }

        const prompt = `Solve the following math problem step by step:\n\n${problem}`;

        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${GOOGLE_GEMINI_API_KEY}`,
            { contents: [{ parts: [{ text: prompt }] }] },
            { headers: { "Content-Type": "application/json" } }
        );

        const solution = response?.data?.candidates?.[0]?.content?.parts?.[0]?.text || "Solution not found.";

        res.json({ success: true, problem, solution });

    } catch (error) {
        console.error("Math Solver Error:", error);
        res.status(500).json({ error: "Failed to solve math problem. Please try again." });
    }
});

    


// Start Server
app.listen(5000, () => console.log(`✅ Server running on port 5000`));
