# Sulit AI

Sulit AI is a Shopping Trust Intelligence engine for Philippine Ecommerce, designed to provide truth-first, production-hardened insights for Shopee PH product URLs.

## Project Structure

- **Backend**: A FastAPI-based Python backend that handles background queueing with PostgreSQL and utilizes an LLM trust analyzer to audit product reviews. 
- **Extension**: A Chrome extension built with Plasmo that serves as the frontend interceptor and UI for product analysis.

## Setup Instructions

Please see [setup.md](./setup.md) for detailed step-by-step instructions on how to set up and run both the Python backend and the Chrome Extension locally.

## Features
- **Async Job Queue**: Polling-based background processing using PostgreSQL.
- **Trust Analyzer**: Audits scraped reviews and product data to generate a "Sulit Score", verify seller trust, check authenticity, and provide helpful pros and cons summaries.
- **Cache Management**: Results are cached in the database with a 24-hour TTL and automatically garbage collected.
