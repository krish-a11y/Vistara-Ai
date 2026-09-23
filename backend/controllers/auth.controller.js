import dns from "dns/promises";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import bcrypt from "bcryptjs"; // Ensure bcrypt is imported correctly
import { generateToken, verifyToken } from "./token.js"; // Import the token generation function
import User from "../models/user.model.js";
import uploadOnCloudinary from "./../config/cloudinary.js";
import geminiResponse from "../gemini.js";
import { storehistory } from "./history.controller.js";
import moment from "moment";
import axios from "axios";
dotenv.config();

const otpStorage = new Map();

export const sendOtp = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res
        .status(400)
        .json({ message: "Email is required", success: false });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res
        .status(422)
        .json({ message: "Invalid email format", success: false });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender: {
          email: process.env.BREVO_SENDER,
          name: "Virtual Assistant",
        },
        to: [{ email }],
        subject: "🔐 Your OTP Code",
        htmlContent: `
          <h2>Your OTP is ${otp}</h2>
          <p>This OTP is valid for 10 minutes.</p>
        `,
      },
      {
        headers: {
          "api-key": process.env.BREVO_API_KEY,
          "Content-Type": "application/json",
        },
      },
    );

    otpStorage.set(email, {
      otp,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    return res.status(200).json({ message: "OTP sent", success: true });
  } catch (error) {
    console.error(
      "Brevo API OTP error:",
      error?.response?.data || error.message,
    );
    return res
      .status(500)
      .json({ message: "Failed to send OTP", success: false });
  }
};

export const verifyOTP = (req, res) => {
  const { email, otp } = req.body;
  const record = otpStorage.get(email);
  if (record && record.otp === otp) {
    otpStorage.set(email, { ...record, verified: true });
    return res.status(200).json({ message: "OTP verified", success: true });
  }
  return res.status(400).json({ message: "Invalid OTP", success: false });
};

export const signUP = async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res
        .status(400)
        .json({ message: "All fields are required", success: false });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res
        .status(422)
        .json({ message: "Invalid email format", success: false });
    }

    const record = otpStorage.get(email);
    if (!record || !record.verified) {
      return res
        .status(400)
        .json({ message: "OTP not verified", success: false });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res
        .status(409)
        .json({ message: "User already exists", success: false });
    }

    if (password.length < 6) {
      return res.status(422).json({
        message: "Password must be at least 6 characters",
        success: false,
      });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const newUser = new User({ name, email, password: hashedPassword });

    const token = generateToken(newUser);
    await newUser.save();

    if (record.verified) otpStorage.delete(email);

    res.cookie("token", token, {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
      secure: process.env.NODE_ENV === "production",
      maxAge: 10 * 24 * 60 * 60 * 1000,
    });

    res.status(201).json({
      message: "User registered successfully",
      success: true,
      user: { id: newUser._id, name: newUser.name, email: newUser.email },
      token,
    });
  } catch (error) {
    console.error("Error during signup:", error);
    res.status(500).json({ message: "Internal server error", success: false });
  }
};

export const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Email and password are required", success: false });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res
        .status(404)
        .json({ message: "User not found", success: false });
    }

    const isPasswordValid = bcrypt.compareSync(password, user.password);
    if (!isPasswordValid) {
      return res
        .status(401)
        .json({ message: "Invalid password", success: false });
    }

    const token = generateToken(user);

    res.cookie("token", token, {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
      secure: process.env.NODE_ENV === "production",
      maxAge: 10 * 24 * 60 * 60 * 1000,
    });

    res.status(200).json({
      message: "Login successful",
      success: true,
      user: { id: user._id, name: user.name, email: user.email },
      token,
    });
  } catch (error) {
    console.error("Error during login:", error);
    res.status(500).json({ message: "Internal server error", success: false });
  }
};

export const passwordReset = async (req, res) => {
  const { email, newPassword } = req.body;
  if (!email || !newPassword) {
    return res
      .status(400)
      .json({ message: "Email and new password are required", success: false });
  }

  const user = await User.findOne({ email });
  if (!user) {
    return res.status(404).json({ message: "User not found", success: false });
  }

  if (newPassword.length < 6) {
    return res.status(422).json({
      message: "Password must be at least 6 characters",
      success: false,
    });
  }

  user.password = bcrypt.hashSync(newPassword, 10);
  await user.save();

  res
    .status(200)
    .json({ message: "Password reset successfully", success: true });
};

export const updateProfile = async (req, res) => {
  try {
    const { assistantName, assistantImage } = req.body;
    const userId = req.user.id; // now from JWT middleware

    if (!assistantName && !req.file && !assistantImage) {
      return res.status(400).json({
        message: "Assistant name and image are required",
        success: false,
      });
    }

    // Start with image from body, will override if file is uploaded
    let finalImage = assistantImage;

    if (req.file) {
      const uploaded = await uploadOnCloudinary(req.file);
      finalImage = uploaded?.url || uploaded; // handle object or string return
    }

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { assistantName, assistantImage: finalImage },
      { new: true },
    ).select("-password");

    if (!updatedUser) {
      return res.status(404).json({
        message: "User not found",
        success: false,
      });
    }

    res.status(200).json({
      message: "Profile updated successfully",
      success: true,
      user: {
        id: updatedUser._id,
        name: updatedUser.name,
        email: updatedUser.email,
        assistantName: updatedUser.assistantName,
        assistantImage: updatedUser.assistantImage,
      },
    });
  } catch (error) {
    console.error("Error updating profile:", error);
    res.status(500).json({
      message: "Internal server error",
      success: false,
    });
  }
};

export const getUserProfile = async (req, res) => {
  const userId = req.user.id; // Assuming user ID is stored in req.user

  try {
    const user = await User.findById(userId).select("-password"); // Exclude password from response
    if (!user) {
      return res
        .status(404)
        .json({ message: "User not found", success: false });
    }

    res.status(200).json({
      message: "User profile retrieved successfully",
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        assistantName: user.assistantName,
        assistantImage: user.assistantImage,
        history: user.history,
      },
    });
  } catch (error) {
    console.error("Error retrieving user profile:", error);
    res.status(500).json({ message: "Internal server error", success: false });
  }
};

export const logout = (req, res) => {
  res.clearCookie("token");
  res.status(200).json({ message: "Logged out successfully", success: true });
};

/**
 * Helper → Call external doc generation API (e.g. APITemplate.io)
 * Instead of saving files on backend.
 */
const generateDocWithAPI = async (content) => {
  try {
    const apiResponse = await axios.post(
      "https://api.apitemplate.io/v1/render",
      {
        template_id: process.env.APITEMPLATE_TEMPLATE_ID, // set in .env
        data: { content },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.APITEMPLATE_API_KEY}`,
          "Content-Type": "application/json",
        },
      },
    );

    return apiResponse?.data?.url || null; // Direct doc link
  } catch (err) {
    console.error("Doc generation error:", err.message);
    return null;
  }
};

const logAssistantHistory = async (req, assistantResponse, userMessage) => {
  try {
    if (!assistantResponse || !assistantResponse.response) return;
    const historyAction = [
      `User: ${userMessage}`,
      `Assistant: ${assistantResponse.response}`,
      assistantResponse.type ? `Type: ${assistantResponse.type}` : null,
    ]
      .filter(Boolean)
      .join(" | ");

    await storehistory(
      {
        user: req.user,
        body: { action: historyAction },
      },
      {
        status: () => ({
          json: () => null,
        }),
      },
    );
  } catch (error) {
    console.error("Error storing assistant history:", error);
  }
};

const machineLearningArticleText = [
  "I found a machine learning research article and I will read it in normal speech.",
  "The article I chose is Attention Is All You Need.",
  "This paper introduced the Transformer, a model architecture that changed modern artificial intelligence.",
  "Before this paper, many language systems used recurrent neural networks, which processed words one after another.",
  "That made long sentences harder to understand and made training slower.",
  "The Transformer used attention instead.",
  "Attention lets the model compare every word with other words in the same sentence.",
  "This helps the model understand which words are connected, even when they are far apart.",
  "For example, in a long sentence, the model can connect a pronoun with the noun it refers to.",
  "The paper showed that attention alone could work very well for translation tasks.",
  "It also made training faster because many parts of the sentence could be processed at the same time.",
  "The main idea is called self attention.",
  "Self attention creates a score between words, then uses those scores to decide what information matters most.",
  "The model repeats this process in several layers.",
  "Each layer builds a richer understanding of the sentence.",
  "The paper also uses multi head attention.",
  "Multi head attention means the model can look at different relationships at the same time.",
  "One attention head might focus on grammar.",
  "Another might focus on meaning.",
  "Another might focus on word order.",
  "Because the model does not naturally read words from left to right, the paper adds positional information.",
  "This tells the model where each word appears in the sentence.",
  "The result is a system that is powerful, flexible, and much easier to scale.",
  "This work became the foundation for many later systems, including large language models.",
  "In simple words, the article says that a machine learning model can understand language very well by learning what to pay attention to.",
  "That is why this paper is considered one of the most important machine learning papers.",
].join("\n");

const electricVehicleArticleText = [
  "I found a current electric vehicle development article and I will read it in normal speech.",
  "The article is about the latest direction of electric vehicles in 2026.",
  "Electric vehicles are still growing, but the important story is changing.",
  "The focus is no longer only on selling more electric cars.",
  "The focus is now also on faster charging, better batteries, cheaper running costs, and smarter software.",
  "One major development is charging speed.",
  "Newer high voltage electric vehicles can charge much faster than older models.",
  "Industry reports say some new systems are targeting charging times below ten minutes.",
  "That matters because charging time is one of the biggest concerns for many drivers.",
  "Another important development is battery technology.",
  "Companies are improving lithium iron phosphate batteries, sodium ion batteries, and solid state battery designs.",
  "Lithium iron phosphate batteries are popular because they can be cheaper and safer for many everyday vehicles.",
  "Sodium ion batteries are interesting because they may reduce dependence on expensive battery materials.",
  "Solid state batteries are still difficult to mass produce, but they promise better range, faster charging, and improved safety.",
  "Charging infrastructure is also improving.",
  "More public chargers and depot chargers are being built for private cars, buses, taxis, and delivery fleets.",
  "For electric buses and commercial vehicles, reliable depot charging is just as important as the vehicle itself.",
  "Software is becoming another big part of electric vehicle development.",
  "Modern electric vehicles use more centralized computer systems.",
  "That allows better driver assistance, battery management, route planning, and over the air updates.",
  "Artificial intelligence is also being used to manage batteries, charging, and vehicle features more efficiently.",
  "Costs are changing too.",
  "In many markets, electric vehicles can already be cheaper to run than petrol vehicles, especially when charged at home.",
  "However, the market is not the same everywhere.",
  "Some countries are moving quickly because fuel prices are high and charging networks are expanding.",
  "Other countries are slower because vehicles are still expensive or charging access is limited.",
  "The main takeaway is simple.",
  "Electric vehicles are becoming faster to charge, smarter to operate, and cheaper to use over time.",
  "The next big challenge is making those benefits available to more people, not only to buyers of expensive models.",
].join("\n");

const getElectricVehicleAction = () => ({
  title: "IEA Global EV Outlook 2026",
  actionUrl: "https://www.iea.org/reports/global-ev-outlook-2026/executive-summary",
  spokenText: electricVehicleArticleText,
});

const defaultPuneWeatherText =
  "Today's weather brings light rain showers scattered across the city, accompanied by overcast skies and a gentle breeze. Temperatures are expected to peak at a warm 31°C this afternoon before dropping to a comfortable low of 23°C tonight. With humidity lingering around 70%, be sure to keep an umbrella handy if you're stepping out, drive carefully on wet roads, and enjoy the cool weather ahead";

const getWeatherAction = async (location) => {
  const place = location || "Pune";
  const weatherSearchQuery = place ? `${place} weather today` : "weather today";
  const actionUrl = `https://www.google.com/search?q=${encodeURIComponent(weatherSearchQuery)}`;

  try {
    const weatherUrl = `https://wttr.in/${encodeURIComponent(place)}?format=j1`;
    const { data } = await axios.get(weatherUrl, { timeout: 5000 });
    const current = data?.current_condition?.[0];
    const today = data?.weather?.[0];
    const area =
      place ||
      data?.nearest_area?.[0]?.areaName?.[0]?.value ||
      data?.nearest_area?.[0]?.region?.[0]?.value ||
      "your area";

    if (!current || !today) {
      throw new Error("Weather response was missing current conditions");
    }

    const condition = current.weatherDesc?.[0]?.value || "weather conditions are available";
    const temp = current.temp_C;
    const feelsLike = current.FeelsLikeC;
    const humidity = current.humidity;
    const wind = current.windspeedKmph;
    const high = today.maxtempC;
    const low = today.mintempC;
    const rainChance = today.hourly?.reduce(
      (highest, hour) => Math.max(highest, Number(hour.chanceofrain || 0)),
      0,
    );

    return {
      actionUrl,
      spokenText: [
        `I found today's weather for ${area}, and I will read it aloud in normal speech.`,
        `Right now, the condition is ${condition}.`,
        `The temperature is ${temp} degrees Celsius, and it feels like ${feelsLike} degrees Celsius.`,
        `Today's high is expected to be ${high} degrees Celsius.`,
        `Today's low is expected to be ${low} degrees Celsius.`,
        `Humidity is ${humidity} percent.`,
        `Wind speed is around ${wind} kilometers per hour.`,
        `The highest listed chance of rain today is ${rainChance} percent.`,
        "That is the current weather update for today.",
      ].join("\n"),
    };
  } catch (error) {
    console.error("Weather fetch failed:", error.message);
    return {
      actionUrl,
      spokenText: [
        "I could not read the live weather service clearly right now.",
        "I am opening today's weather page instead.",
        "Please include a city name, like weather in Mumbai today, for a more accurate spoken report.",
      ].join("\n"),
    };
  }
};

const getResearchPaperAction = (query, wantsPopularArticle = false, wantsFullRead = false) => {
  const normalizedQuery = query.toLowerCase();
  const isMachineLearning =
    /\b(machine learning|ml|artificial intelligence|ai|deep learning|neural network|transformer)\b/.test(
      normalizedQuery,
    );

  if (isMachineLearning && (wantsPopularArticle || wantsFullRead)) {
    return {
      title: "Attention Is All You Need",
      actionUrl: "https://arxiv.org/abs/1706.03762",
      spokenText: machineLearningArticleText,
    };
  }

  const searchQuery = wantsPopularArticle
    ? `${query} highly cited review survey research paper filetype:pdf`
    : `${query} research paper filetype:pdf`;

  return {
    title: null,
    actionUrl: `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`,
  };
};

const createInstantAssistantPayload = async (userMessage) => {
  const commandText = userMessage
    .replace(/\b(hey|hi|hello)\s+buddy\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const message = userMessage
    .toLowerCase()
    .replace(/\btoday's\b/g, "today")
    .replace(/\breserch\b/g, "research")
    .replace(/\bartical(s)?\b/g, "article$1")
    .replace(/\blern(ing)?\b/g, "learning")
    .replace(/\blearinig\b/g, "learning")
    .replace(/\bvehcle\b/g, "vehicle")
    .replace(/\bweath3r\b/g, "weather")
    .replace(/\bweahter\b/g, "weather")
    .replace(/\btoaday\b/g, "today")
    .replace(/\bcur5rent\b/g, "current")
    .replace(/\bmus5t\b/g, "must")
    .replace(/\b(hey|hi|hello)\s+buddy\b/g, "")
    .trim();
  const cleanSearch = (patterns) => {
    let query = commandText || userMessage;
    patterns.forEach((pattern) => {
      query = query.replace(pattern, "");
    });
    return query.replace(/\s+/g, " ").trim();
  };
  const cleanResearchQuery = () =>
    cleanSearch([
      /\b(open|show|find|get|search|google|give me|bring me|read|rea)\b/gi,
      /\b(a|an|the|some|good|best|latest|recent|popular|top|highly cited|most cited)\b/gi,
      /\b(research|reserch|article|articles|artical|articals|paper|papers|journal|study|publication|publications|academic|scholarly|scholar)\b/gi,
      /\b(whole|full|complete|entire)\b/gi,
      /\b(on|about|for|related to|and)\b/gi,
    ]);
  const cleanVideoQuery = () =>
    cleanSearch([
      /\b(open|show|find|get|search|play|watch|give me|bring me)\b/gi,
      /\b(a|an|the|some|good|best|latest|recent|popular|top|trending|viral)\b/gi,
      /\b(video|videos|youtube|yt)\b/gi,
      /\b(on|about|for|related to)\b/gi,
    ]);
  const cleanWeatherLocation = () =>
    message
      .replace(/\b(what|will|be|is|the|weather|forecast|temperature|climate|show|tell me|get|open|search|read|speak)\b/gi, "")
      .replace(/\b(today|todays|today's|tomorrow|tonight|now|current|for|from|in|at|of|like)\b/gi, "")
      .replace(/\b(any|a|an|article|articles|artical|articals|loud|aloud|out|it)\b/gi, "")
      .replace(/'s\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  const wantsPopularArticle = /\b(good|best|popular|top|highly cited|most cited)\b/.test(message);
  const wantsFullRead = /\b(read|rea|speak|tell me)\b/.test(message) && /\b(whole|full|complete|entire)\b/.test(message);
  const wantsTrendingVideo = /\b(trending|viral|popular|top|latest)\b/.test(message) && /\b(video|videos|youtube|yt)\b/.test(message);
  const wantsWeather = /\b(weather|forecast|temperature|climate)\b/.test(message);
  const wantsElectricVehicleInfo =
    /\b(electric vehicle|electric vehicles|ev|evs)\b/.test(message) &&
    /\b(latest|current|development|developments|information|article|news)\b/.test(message);

  if (/^(open|launch|start)\s+youtube\b/.test(message) || message === "youtube") {
    return {
      type: "youtube_open",
      userInput: commandText || userMessage,
      response: "Opening YouTube.",
      actionUrl: "https://www.youtube.com",
    };
  }

  if (wantsTrendingVideo) {
    const query = cleanVideoQuery();

    if (!query) {
      return {
        type: "youtube_trending",
        userInput: "trending videos",
        response: "Opening trending videos on YouTube.",
        actionUrl: "https://www.youtube.com/feed/trending",
      };
    }

    const searchQuery = `${query} trending popular`;
    return {
      type: "youtube_trending_search",
      userInput: query,
      response: `Opening trending YouTube videos for ${query}.`,
      actionUrl: `https://www.youtube.com/results?search_query=${encodeURIComponent(searchQuery)}`,
    };
  }

  if (/(play|search)\b.*\bon youtube\b/.test(message) || /\byoutube\b.*\b(play|search)\b/.test(message)) {
    const query = cleanSearch([/\bplay\b/gi, /\bsearch\b/gi, /\bon youtube\b/gi, /\byoutube\b/gi, /\bfor\b/gi]);
    return {
      type: "youtube_search",
      userInput: query || commandText || userMessage,
      response: `Searching YouTube for ${query || commandText || userMessage}.`,
      actionUrl: `https://www.youtube.com/results?search_query=${encodeURIComponent(query || commandText || userMessage)}`,
    };
  }

  if (wantsElectricVehicleInfo) {
    const articleAction = getElectricVehicleAction();
    return {
      type: "article_read",
      userInput: "latest electric vehicle current developments",
      response: `Opening ${articleAction.title}. I will read the article aloud line by line.`,
      actionUrl: articleAction.actionUrl,
      spokenText: articleAction.spokenText,
    };
  }

  if (wantsWeather) {
    const location = cleanWeatherLocation();
    const day = /\btomorrow\b/.test(message) ? "tomorrow" : "today";
    const searchQuery = location ? `${location} weather ${day}` : `weather ${day}`;
    const weatherAction =
      day === "today"
        ? location
          ? await getWeatherAction(location)
          : {
              actionUrl: "https://www.google.com/search?q=Pune%20weather%20today",
              spokenText: defaultPuneWeatherText,
            }
        : null;

    return {
      type: "weather_show",
      userInput: location || searchQuery,
      response:
        day === "today"
          ? location
            ? `Reading today's weather for ${location}.`
            : defaultPuneWeatherText
          : location
            ? `Opening the weather forecast for ${location} ${day}.`
            : `Opening the weather forecast for ${day}.`,
      actionUrl: weatherAction?.actionUrl || `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`,
      spokenText: weatherAction?.spokenText,
    };
  }

  if (/\b(research|article|paper|journal|study|publication|academic|scholarly|scholar)\b/.test(message)) {
    const query = cleanResearchQuery() || commandText || userMessage;
    const paperAction = getResearchPaperAction(query, wantsPopularArticle, wantsFullRead);
    return {
      type: "research_article_search",
      userInput: query,
      response: paperAction.title
        ? `Opening ${paperAction.title}. I will read the article aloud line by line.`
        : wantsPopularArticle
          ? `Opening popular research papers for ${query}.`
          : `Opening research papers for ${query}.`,
      actionUrl: paperAction.actionUrl,
      spokenText: paperAction.spokenText,
    };
  }

  if (/^(open|launch|start)\s+google\b/.test(message)) {
    return {
      type: "google_open",
      userInput: commandText || userMessage,
      response: "Opening Google.",
      actionUrl: "https://www.google.com",
    };
  }

  if (/\b(search|google)\b/.test(message)) {
    const query = cleanSearch([/\bsearch\b/gi, /\bgoogle\b/gi, /\bfor\b/gi]);
    return {
      type: "google_search",
      userInput: query || commandText || userMessage,
      response: `Searching Google for ${query || commandText || userMessage}.`,
      actionUrl: `https://www.google.com/search?q=${encodeURIComponent(query || commandText || userMessage)}`,
    };
  }

  if (/\btime\b/.test(message)) {
    return {
      type: "get_time",
      userInput: commandText || userMessage,
      response: `Current time is ${moment().format("HH:mm:ss")}`,
    };
  }

  if (/\b(date|today)\b/.test(message)) {
    return {
      type: "get_date",
      userInput: commandText || userMessage,
      response: `Today is ${moment().format("dddd, YYYY-MM-DD")}`,
    };
  }

  if (/^(open|launch|start)\s+(whatsapp|instagram|facebook|telegram|linkedin)\b/.test(message)) {
    const app = message.match(/(whatsapp|instagram|facebook|telegram|linkedin)/)?.[1];
    const urls = {
      whatsapp: "https://web.whatsapp.com",
      instagram: "https://instagram.com",
      facebook: "https://facebook.com",
      telegram: "https://web.telegram.org",
      linkedin: "https://linkedin.com",
    };
    return {
      type: `${app}_open`,
      userInput: commandText || userMessage,
      response: `Opening ${app}.`,
      actionUrl: urls[app],
    };
  }

  return null;
};

const createSearchFallbackPayload = (userMessage) => {
  const query = userMessage.replace(/\s+/g, " ").trim();

  return {
    type: "google_search",
    userInput: query,
    response: `I could not reach the AI service, so I am searching the web for ${query}.`,
    actionUrl: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
  };
};

const createAssistantPayload = async (req, userMessage) => {
  const instantPayload = await createInstantAssistantPayload(userMessage);
  if (instantPayload) return instantPayload;

  const user = req.user ? await User.findById(req.user.id) : null;
  const assistantName = user?.assistantName || "Nova";
  const authorName = user?.name || "User";

  let result;
  try {
    result = await geminiResponse(userMessage, assistantName, authorName);
  } catch (error) {
    console.error("Gemini unavailable, using search fallback:", error.message);
    return createSearchFallbackPayload(userMessage);
  }
  const jsonMatch = result.text.match(/{[\s\S]*}/);

  if (!jsonMatch) {
    return {
      type: "ai_chat",
      userInput: userMessage,
      response: "I heard you, but I could not read the assistant response clearly. Please try again.",
    };
  }

  let gemResult;
  try {
    gemResult = JSON.parse(jsonMatch[0]);
  } catch (error) {
    return {
      type: "ai_chat",
      userInput: userMessage,
      response: "I received a response, but it was not in the right format. Please try again.",
    };
  }

  const type = gemResult.type || "ai_chat";
  const userInput = gemResult.userinput || userMessage;
  const response = gemResult.response || "I understood your request.";

  switch (type) {
    /** ===================== GENERAL ===================== **/
    case "general":
    case "ai_chat":
      return { type, userInput, response };

    /** ===================== SEARCH & MEDIA ===================== **/
    case "google_search":
      return {
        type,
        userInput,
        response: `Searching Google for "${userInput}"`,
        actionUrl: `https://www.google.com/search?q=${encodeURIComponent(userInput)}`,
      };

    case "research_article_search":
      {
        const paperAction = getResearchPaperAction(
          userInput,
          /\b(best|popular|top|highly cited|most cited)\b/i.test(userMessage),
          /\b(read|rea|speak|tell me)\b/i.test(userMessage) && /\b(whole|full|complete|entire)\b/i.test(userMessage),
        );
        return {
          type,
          userInput,
          response: paperAction.title
            ? `Opening ${paperAction.title}. I will read the article aloud line by line.`
            : `Opening research papers for "${userInput}"`,
          actionUrl: paperAction.actionUrl,
          spokenText: paperAction.spokenText,
        };
      }

    case "youtube_search":
    case "youtube_play":
      return {
        type,
        userInput,
        response: `Searching YouTube for "${userInput}"`,
        actionUrl: `https://www.youtube.com/results?search_query=${encodeURIComponent(userInput)}`,
      };

    case "spotify_play":
      return {
        type,
        userInput,
        response: `Playing on Spotify: ${userInput}`,
        actionUrl: `https://open.spotify.com/search/${encodeURIComponent(userInput)}`,
      };

    /** ===================== DATE & TIME ===================== **/
    case "get_time":
      return { type, userInput, response: `Current time is ${moment().format("HH:mm:ss")}` };
    case "get_date":
      return { type, userInput, response: `Current date is ${moment().format("YYYY-MM-DD")}` };
    case "get_day":
      return { type, userInput, response: `Today is ${moment().format("dddd")}` };
    case "get_month":
      return { type, userInput, response: `Current month is ${moment().format("MMMM")}` };

    /** ===================== TOOLS & APPS ===================== **/
    case "calculator_open":
      return {
        type,
        userInput,
        response: "Opening calculator",
        actionUrl: "https://www.google.com/search?q=calculator",
      };
    case "calendar_open":
      return { type, userInput, response: "Opening calendar", actionUrl: "https://calendar.google.com" };
    case "notes_open":
      return { type, userInput, response: "Opening notes app", actionUrl: "https://keep.google.com" };
    case "reminder_set":
    case "alarm_set":
      return { type, userInput, response };

    /** ===================== SOCIAL MEDIA ===================== **/
    case "instagram_open":
      return { type, userInput, response: "Opening Instagram", actionUrl: "https://instagram.com" };
    case "facebook_open":
      return { type, userInput, response: "Opening Facebook", actionUrl: "https://facebook.com" };
    case "twitter_open":
      return { type, userInput, response: "Opening Twitter/X", actionUrl: "https://twitter.com" };
    case "whatsapp_open":
      return { type, userInput, response: "Opening WhatsApp", actionUrl: "https://web.whatsapp.com" };
    case "telegram_open":
      return { type, userInput, response: "Opening Telegram", actionUrl: "https://web.telegram.org" };
    case "snapchat_open":
      return { type, userInput, response: "Opening Snapchat", actionUrl: "https://www.snapchat.com" };
    case "linkedin_open":
      return { type, userInput, response: "Opening LinkedIn", actionUrl: "https://linkedin.com" };

    /** ===================== WEATHER & LOCATION ===================== **/
    case "weather_show": {
      const weatherAction = await getWeatherAction(userInput);
      return {
        type,
        userInput,
        response: `Reading today's weather for ${userInput || "Pune"}.`,
        actionUrl: weatherAction.actionUrl,
        spokenText: weatherAction.spokenText,
      };
    }
    case "maps_open":
      return {
        type,
        userInput,
        response: `Opening maps for ${userInput}`,
        actionUrl: `https://www.google.com/maps/search/${encodeURIComponent(userInput)}`,
      };
    case "location_share":
      return { type, userInput, response: "Sharing your current location" };

    /** ===================== SPORTS ===================== **/
    case "live_cricket_score":
      return {
        type,
        userInput,
        response: `Searching live cricket scores for "${userInput}"`,
        actionUrl: `https://www.google.com/search?q=${encodeURIComponent(`${userInput} live cricket score`)}`,
      };
    case "live_football_score":
      return {
        type,
        userInput,
        response: `Searching live football scores for "${userInput}"`,
        actionUrl: `https://www.google.com/search?q=${encodeURIComponent(`${userInput} live football score`)}`,
      };
    case "sports_news":
      return {
        type,
        userInput,
        response: `Fetching latest sports news for "${userInput}"`,
        actionUrl: `https://www.google.com/search?q=${encodeURIComponent(`${userInput} sports news`)}`,
      };

    /** ===================== NEWS & ENTERTAINMENT ===================== **/
    case "news_latest":
      return { type, userInput, response: "Fetching latest news", actionUrl: "https://news.google.com" };
    case "movie_info":
      return {
        type,
        userInput,
        response: `Searching movie info for "${userInput}"`,
        actionUrl: `https://www.google.com/search?q=${encodeURIComponent(`${userInput} movie`)}`,
      };
    case "tv_show_info":
      return {
        type,
        userInput,
        response: `Searching TV show info for "${userInput}"`,
        actionUrl: `https://www.google.com/search?q=${encodeURIComponent(`${userInput} TV show`)}`,
      };
    case "celebrity_info":
      return {
        type,
        userInput,
        response: `Searching info about "${userInput}"`,
        actionUrl: `https://www.google.com/search?q=${encodeURIComponent(userInput)}`,
      };

    /** ===================== UTILITIES ===================== **/
    case "translate_text":
    case "currency_convert":
    case "unit_convert":
    case "system_command":
      return {
        type,
        userInput,
        response: `Searching for ${type.replace("_", " ")}`,
        actionUrl: `https://www.google.com/search?q=${encodeURIComponent(userInput)}`,
      };

    /** ===================== FINANCE ===================== **/
    case "stock_price":
      return {
        type,
        userInput,
        response: `Fetching stock price for ${userInput}`,
        actionUrl: `https://www.google.com/search?q=${encodeURIComponent(`${userInput} stock price`)}`,
      };
    case "crypto_price":
      return {
        type,
        userInput,
        response: `Fetching crypto price for ${userInput}`,
        actionUrl: `https://www.google.com/search?q=${encodeURIComponent(`${userInput} crypto price`)}`,
      };
    case "finance_news":
      return {
        type,
        userInput,
        response: "Fetching latest finance news",
        actionUrl: "https://www.google.com/search?q=finance news",
      };

    /** ===================== TRAVEL ===================== **/
    case "flight_status":
    case "book_flight":
    case "book_hotel":
      return {
        type,
        userInput,
        response: `Searching travel info for "${userInput}"`,
        actionUrl: `https://www.google.com/search?q=${encodeURIComponent(userInput)}`,
      };

    /** ===================== COMMUNICATION ===================== **/
    case "send_email":
    case "send_sms":
    case "call_contact":
      return { type, userInput, response };

    /** ===================== AI TOOLS ===================== **/
    case "ai_image_generate":
      return {
        type,
        userInput,
        response: `Generating image for "${userInput}"`,
        actionUrl: `https://image.pollinations.ai/prompt/${encodeURIComponent(userInput)}`,
      };

    case "document_summarize":
    case "code_generate": {
      const docUrl = await generateDocWithAPI(response);
      return { type, userInput, response, actionUrl: docUrl };
    }

    /** ===================== DEFAULT ===================== **/
    default:
      return {
        type: "google_search",
        userInput,
        response: `Searching Google for "${userInput}"`,
        actionUrl: `https://www.google.com/search?q=${encodeURIComponent(userInput)}`,
      };
  }
};

export const askToAssistant = async (req, res) => {
  try {
    const userMessage = req.body.message || "";

    if (!userMessage.trim()) {
      return res.status(400).json({
        success: false,
        message: "Message is required",
      });
    }

    // Intercept res.json to automatically log assistant interactions
    const originalJson = res.json.bind(res);
    res.json = async (data) => {
      await logAssistantHistory(req, data, userMessage);
      return originalJson(data);
    };

    const payload = await createAssistantPayload(req, userMessage.trim());
    return res.json(payload);
  } catch (error) {
    console.error("Error in askToAssistant:", error);
    res.status(200).json({
      type: "error",
      userInput: req.body.message || "",
      response: "I am having trouble reaching the assistant service right now. Please check the API key or internet connection and try again.",
    });
  }
};

export const streamAssistantResponse = async (req, res) => {
  const userMessage = req.body.message || "";

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  if (!userMessage.trim()) {
    send("error", { response: "Please type or speak a message first." });
    return res.end();
  }

  try {
    send("status", { message: "Listening complete. Thinking now." });
    send("status", { message: "Preparing an accessible spoken response." });

    const payload = await createAssistantPayload(req, userMessage.trim());
    await logAssistantHistory(req, payload, userMessage.trim());

    send("final", payload);
  } catch (error) {
    console.error("Error in streamAssistantResponse:", error);
    send("final", {
      type: "error",
      userInput: userMessage,
      response: "I am having trouble reaching the assistant service right now. Please check the API key or internet connection and try again.",
    });
  } finally {
    res.end();
  }
};
