Here is the fully updated and consolidated **Technical Requirements Document (TRD) v2.0**. It strictly enforces the `ap-southeast-3` data residency constraint, replacing the cross-region Inference Profiles with Provisioned Throughput and an asynchronous processing architecture to ensure reliability without violating data sovereignty.

---

# **Technical Requirements Document (TRD)**
**Project:** `beexexity` - Enterprise File Generation & Native Bedrock Enhancements  
**Version:** 2.0 (Strict Data Residency Enforced)  
**Status:** Final Draft for Engineering & Security Assessment  
**Core Constraint:** **STRICT DATA RESIDENCY IN `ap-southeast-3` (Jakarta, Indonesia). NO CROSS-REGION FAILOVER.**

## **1. Executive Summary**
This document outlines the requirements to upgrade the `beexexity` inference gateway to support enterprise-grade Presentation (PPTX) and PDF document generation. To comply with strict Indonesian data sovereignty regulations (UU PDP), all AI processing, storage, and compute must remain strictly within `ap-southeast-3` (AWS) and `asia-southeast2` (GCP). 

This initiative leverages native AWS Bedrock features: **Guardrails** (for content safety), **Provisioned Throughput** (for guaranteed regional capacity), and **Bedrock Agents** (for managed multi-step orchestration), integrated via an asynchronous job queue to handle heavy workloads reliably within a single region.

## **2. Business & Technical Objectives**
*   **Absolute Data Sovereignty:** Guarantee that 100% of prompt data, generated files, and vector embeddings never leave the Jakarta region (AWS `ap-southeast-3` / GCP `asia-southeast2`).
*   **Security & Accuracy:** Eliminate hallucinations and ensure zero leakage of restricted topics using native Bedrock Guardrails.
*   **Resilient Throughput:** Guarantee capacity for heavy file-generation tasks using Bedrock Provisioned Throughput and asynchronous job processing, bypassing on-demand regional throttling.
*   **Architectural Simplicity:** Offload complex `toolUse`/`toolResult` state management from the Express.js middleware to Amazon Bedrock Agents.

## **3. Scope**
*   **In-Scope:** Configuration of Bedrock Guardrails, purchase/allocation of Provisioned Throughput in `ap-southeast-3`, setup of Bedrock Agents, definition of Action Groups (Tools) for PPTX/PDF generation, implementation of an async job queue, and integration with the existing GCP Cloud Run Express API.
*   **Out-of-Scope:** Cross-region inference profiles, Bedrock Knowledge Bases (Priority 4), Model Evaluation (Priority 5), and the internal Node.js logic for `PptxGenJS`/Gotenberg.

---

## **4. Detailed Feature Requirements**

### **Feature 1: Amazon Bedrock Guardrails (Priority 1)**
**Objective:** Apply a fail-closed safety and quality layer to all generated document content strictly within the Jakarta region.

**4.1.1 Functional Requirements:**
*   **FR1.1 - Regional Pinning:** The Guardrail must be created and provisioned exclusively in `ap-southeast-3`.
*   **FR1.2 - Topic Denial:** Configure the Guardrail to block the generation of content related to defined "Denied Topics" (e.g., specific competitor names, restricted internal project codenames).
*   **FR1.3 - Contextual Grounding:** Enable the Contextual Grounding filter. When the Agent retrieves data to populate slides, the Guardrail must verify that the generated bullet points are strictly supported by the retrieved source text.
*   **FR1.4 - PII Redaction (Defense in Depth):** Enable native PII detection (specifically for Indonesian entities like NIK, KTP, phone numbers) as a secondary net, complementing `beexexity`'s pre-inference masking.
*   **FR1.5 - Blocked Response Handling:** If intercepted, the Guardrail must return a standardized, sanitized JSON payload to the Agent indicating the block reason, without leaking raw guardrail configurations to the end-user.

### **Feature 2: Provisioned Throughput & Async Processing (Priority 2)**
**Objective:** Ensure guaranteed throughput and zero-downtime for heavy PPTX/PDF generation tasks without violating the single-region constraint. *(Replaces Cross-Region Inference Profiles)*.

**4.2.1 Functional Requirements:**
*   **FR2.1 - Strict Regional Pinning:** All Bedrock API calls must explicitly target `ap-southeast-3`. Multi-region Inference Profiles are strictly prohibited.
*   **FR2.2 - Provisioned Throughput (PT):** Purchase/allocate **Provisioned Throughput** in `ap-southeast-3` for the foundation models used by the Agent (e.g., Claude 3.5 Sonnet or Amazon Nova Pro). This guarantees dedicated TPS capacity, isolating file-generation workloads from public on-demand throttling.
*   **FR2.3 - Asynchronous Job Queue Pattern:** Because heavy document generation can take 15–60 seconds, the API must **not** be synchronous. 
    *   The Express app will accept the request, push a job to a queue (e.g., Redis BullMQ or GCP Cloud Tasks), and immediately return a `202 Accepted` with a `job_id`.
    *   A background worker will poll the Bedrock Agent, handle retries with exponential backoff if transient regional limits are hit, and update the job status.
*   **FR2.4 - GCP Regional Alignment:** The `beexexity` GCP Cloud Run service and the background worker **must** be deployed in `asia-southeast2` (Jakarta) to ensure data does not traverse international borders between GCP and AWS.

### **Feature 3: Amazon Bedrock Agents & Tool Integration (Priority 3)**
**Objective:** Replace custom Node.js tool-calling loops with managed, multi-step Agent orchestration.

**4.3.1 Functional Requirements:**
*   **FR3.1 - Agent Definition:** Create a Bedrock Agent in `ap-southeast-3` with a customized instruction set tailored for document synthesis and strict JSON schema adherence.
*   **FR3.2 - Action Groups (Tools):** Define the following tools for the Agent:
    *   `generate_presentation`: Accepts a strict JSON schema (title, slides array with headings, bullets, layout).
    *   `generate_pdf`: Accepts Markdown/HTML or a reference to a generated PPTX to convert to PDF.
*   **FR3.3 - Internal API Bridge:** Since the Agent is invoked by an internal background worker (not directly by the public API Gateway), the Agent's tool invocations will call an **internal, authenticated endpoint** on the `beexexity` Express app (e.g., via VPC Service Controls, Private Service Connect, or strict mTLS/IAM auth).
*   **FR3.4 - Session Memory:** Enable the Agent's native short-term memory to maintain context if the user asks to "change the background color of slide 3" in a subsequent prompt.

---

## **5. Architecture & Sequence Flow**

1. **User Request:** Client requests: *"Create a 10-slide deck about Q3 earnings."*
2. **Express API (`asia-southeast2`):** Receives request, validates auth, creates a `job_id`, pushes payload to the internal message queue, and returns `202 Accepted` to the client.
3. **Background Worker (`asia-southeast2`):** Picks up the job. Invokes the **Bedrock Agent** (strictly pinned to `ap-southeast-3`).
4. **Bedrock Agent (`ap-southeast-3`):** Evaluates prompt against **Guardrails**. Agent reasons and decides to call the `generate_presentation` tool.
5. **Agent Tool Invocation:** Agent calls the `beexexity` internal Tool Execution Endpoint.
6. **Cloud Run Execution (`asia-southeast2`):** 
   * Express app receives JSON, validates with **Zod**.
   * **PptxGenJS** generates the file in memory.
   * File is uploaded to an **AWS S3 bucket located strictly in `ap-southeast-3`**.
   * Returns the S3 URL to the Agent.
7. **Agent Synthesis:** Agent formats the final natural language response ("Here is your presentation...").
8. **Job Completion:** Background worker updates the job status to `Completed` with the S3 URL.
9. **Client Polling:** The frontend polls the `/api/jobs/{job_id}` endpoint and displays the secure download link once ready.

---

## **6. Security, IAM & Data Considerations**

*   **Strict Data Residency Enforcement:** 
    *   AWS Bedrock resources (Agents, Guardrails) must be created *only* in `ap-southeast-3`.
    *   **S3 Bucket Policy:** The S3 bucket storing generated PPTX/PDF files must have a strict bucket policy denying any `s3:PutObject` or `s3:GetObject` requests originating outside `ap-southeast-3` (using the `aws:RequestedRegion` condition key).
    *   GCP Cloud Run and background workers must be deployed in `asia-southeast2` (Jakarta).
*   **IAM Roles:** 
    *   Create a specific `BedrockAgentExecutionRole`.
    *   Grant least-privilege permissions with strict resource-level conditions: `bedrock:InvokeModel` and `bedrock:ApplyGuardrail` allowed *only* for ARNs containing `ap-southeast-3`.
*   **No Data Logging Outside Region:** Ensure CloudWatch Logs, X-Ray traces, and VPC flow logs are strictly confined to `ap-southeast-3`. Disable any cross-region log aggregation or global S3 replication.
*   **Interconnect Security:** Traffic between GCP `asia-southeast2` and AWS `ap-southeast-3` must be encrypted in transit (TLS 1.2+). If public internet is used, it must be secured via strict IAM authentication or mTLS. Evaluate AWS Direct Connect / GCP Partner Interconnect for private peering if latency/security requires it.

---

## **7. Testing & Evaluation Strategy**

*   **Data Residency Testing:** Use AWS CloudTrail and GCP Audit Logs to verify that no API calls, S3 object creations, or log exports occur outside the designated Jakarta regions.
*   **Guardrails Testing:** Create a test suite of "adversarial prompts" (e.g., asking the Agent to include competitor data or hallucinated financial figures) to verify the Guardrail blocks them and returns the correct fallback message.
*   **Async & Throughput Testing:** Load-test the asynchronous queue and Provisioned Throughput. Verify that the background worker gracefully handles Bedrock throttling via exponential backoff without dropping jobs.
*   **Agent Loop Testing:** Intentionally send malformed JSON to the `beexexity` API to trigger a 400 error. Verify that the Bedrock Agent successfully reads the error, corrects the JSON, and retries without infinite looping.

---

## **8. Open Questions & Risks for Assessment**

1. **Provisioned Throughput Cost vs. On-Demand:** Purchasing Provisioned Throughput in `ap-southeast-3` requires a 1-month or 6-month commitment. *Action:* Product/Finance team must analyze the expected volume of PPTX/PDF generation to determine if PT is more cost-effective than paying on-demand rates with strict rate-limiting.
2. **GCP-AWS Interconnect Latency:** While both are in Jakarta, traffic between GCP and AWS traverses the public internet unless a dedicated interconnect is established. *Action:* Measure latency during the MVP phase. If the round-trip time for tool execution exceeds acceptable thresholds, evaluate private peering.
3. **Gotenberg Sidecar Location:** If using Gotenberg for PDF conversion, the Gotenberg Docker container must also run within the same `asia-southeast2` GCP environment to ensure the source PPTX file and the resulting PDF never leave the Jakarta region.
4. **Client Timeout Handling:** Because the process is now asynchronous, the frontend client must be updated to handle `202 Accepted` responses and implement robust polling or WebSocket connections to listen for job completion, rather than waiting for a synchronous HTTP response./