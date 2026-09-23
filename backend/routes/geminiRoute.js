import express from "express";
import { askToAssistant, streamAssistantResponse } from "../controllers/auth.controller.js";

const aiRoute = express.Router();

// AI Assistant route for the main accessible experience
aiRoute.post("/getRespone", askToAssistant);
aiRoute.post("/response", askToAssistant);
aiRoute.post("/stream", streamAssistantResponse);

export default aiRoute;
