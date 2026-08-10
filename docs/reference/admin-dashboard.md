Here is the updated Product Requirements Document (PRD), incorporating the new `groupName` field into both the Single User and Bulk Upload workflows.

---

# Refined Product Requirements Document: Admin Menu UI

## 1. Access Control & Navigation Flow
* **Entry Point:** The Admin Menu is accessed by clicking the **User Account Icon** (top-right header).
* **Role-Based Interaction:**
  * **If `role == admin`:** Clicking the icon opens a dropdown containing a clickable **"Admin Menu"** option.
  * **If `role != admin`:** The **"Admin Menu"** option is **disabled and not clickable** (visually greyed out or hidden).
* **Route Protection:** Direct URL access to admin routes by non-admin users redirects to a `403 Forbidden` page.

---

## 2. Functional Requirements

### 2.1. User Management
**Objective:** Allow admins to manage users individually or in bulk. This section is divided into two distinct modes/tabs: **Single User** and **Bulk Upload**.

#### Mode A: Single User (Manual Input)
* **Target User Input:** A text input field to manually type the exact `username`.
* **Update Form:**
  * **Display Name:** Text input.
  * **Group Name:** Text input (e.g., "IT Business Enablement").
  * **Role:** Dropdown (`admin`, `user`).
  * **New Password:** Password input (min 6 characters). *Leave blank if not updating.*
  * **Force Password Reset:** Toggle switch / Checkbox.
* **Action Button:** "Update User".
* **API Integration:** Calls `PUT /api/v1/admin/users/:username`. Only sends modified fields.

#### Mode B: Bulk Upload (JSON File)
* **Objective:** Bulk register or update multiple users simultaneously using a JSON file.
* **File Upload Component:** 
  * Accepts only `.json` files.
  * Includes a "Download Template" button that downloads a sample JSON file to guide the admin.
* **JSON Schema Validation:** Upon file selection, the frontend must parse and validate the JSON against the required schema before allowing submission.
  * **Expected JSON Structure:**
    ```json
    [
      {
        "username": "johndoe",
        "displayName": "John Doe",
        "groupName": "IT Business Enablement",
        "role": "user",
        "password": "SecurePass123",
        "forcePasswordReset": true
      },
      {
        "username": "janedoe",
        "displayName": "Jane Doe",
        "groupName": "Finance",
        "role": "admin",
        "password": "AnotherPass456",
        "forcePasswordReset": false
      }
    ]
    ```
  * **Validation Rules:** 
    * Must be a valid JSON array.
    * Each object must contain `username`, `role`, `password` (min 6 chars), and `forcePasswordReset` (boolean).
    * `groupName` and `displayName` should be validated as strings.
    * `role` must strictly be `"admin"` or `"user"`.
* **Preview & Confirmation:** Display a parsed table preview of the users to be processed (including the new `groupName` column). Require the admin to click "Confirm & Process" to begin.
* **Action Button:** "Process Bulk Upload".

**Bulk API Integration & Execution Logic:**
* *Note: The frontend must handle the batch processing by iterating through the validated JSON array and firing the `PUT` request for each user.*
* **Execution:** Process requests in small batches (e.g., 5 concurrent requests at a time) to prevent browser/network throttling.
* **Progress Tracking:** Display a progress bar or text indicator (e.g., "Processing 15 of 50...").

**Bulk Result Summary UI:**
Once processing finishes, display a summary modal/section:
* **Total Processed:** X users.
* **Successful:** Y users (Show in green).
* **Failed:** Z users (Show in red).
* **Error Details:** A collapsible list or downloadable CSV showing exactly which usernames failed and the specific API error message returned.

---

### 2.2. Usage & Cost Dashboard
**Objective:** View and analyze system usage costs across users over a specific time period.

**UI Components:**
* **Filters:** Date Range Picker (`From` and `To` dates). *Default to the current month.*
* **Summary Card:** Display the `grandTotal` cost prominently.
* **Data Table:** Display the `users` array containing individual user costs.
* **Pagination:** Controls for `page` and `pageSize`. "Next" button enabled only if `hasMore` is true.

**API Integration:**
* **Endpoint:** `GET /api/v1/admin/usage/cost`
* **Query Parameters:** `from` (ISO date), `to` (ISO date), `page` (default 1), `pageSize` (max 100).

---

### 2.3. Account Settings (Change Password)
**Objective:** Allow the admin to update their own password.

**UI Components:**
* **Form:** Current Password, New Password (min 6 chars), Confirm New Password.
* **Action Button:** "Update Password".

**API Integration:**
* **Endpoint:** `POST /api/v1/auth/change-password`
* **Payload:** `{ "currentPassword": "...", "newPassword": "..." }`
* **Success State:** Display success toast. *Clears the `force_password_reset` flag automatically.*

---

## 3. API Integration Specifications

* **Base URL:** `https://beexexity-692068716695.asia-southeast2.run.app` or 'Localhost:3000' for local
* **Headers:**
  * `Content-Type: application/json`
  * `Authorization: Bearer <token>`

### Error Handling Requirements:
* **`401 Unauthorized`:** Redirect to login.
* **`403 Forbidden`:** Show "Access Denied". *Edge Case: If the admin is flagged for forced reset, redirect them to Account Settings.*
* **`400 Bad Request`:** Display inline validation errors (e.g., "Password must be at least 6 characters").
* **`404 Not Found`:** (For Single User mode) Show "User not found" if the manual username doesn't exist. *(Note: For Bulk mode, a 404 means the user doesn't exist; the UI should log the API response as a failure for that specific user).*

---

## 4. Edge Cases & UX Considerations

1. **Upsert Behavior in Bulk:** The `PUT` endpoint acts as an "Upsert" (Create or Update). If a `username` in the JSON file does not exist, it will be created. If it exists, it will be updated. The UI should inform the admin of this behavior.
2. **Admin Lockout Prevention:** 
   * *Single Mode:* Prevent admins from typing their *own* username to force a password reset on themselves.
   * *Bulk Mode:* If the admin includes their own username in the JSON file with `forcePasswordReset: true`, show a warning modal: *"You are attempting to force a password reset on your own account. This will log you out. Proceed?"*
3. **Large File Handling:** Implement a hard limit in the UI (e.g., max 1,000 users per upload) to prevent browser crashes, and chunk the API requests to avoid network timeouts.
4. **JSON Parsing Errors:** If the uploaded file is not valid JSON, or doesn't match the array-of-objects schema, immediately reject the file and show a clear error message without attempting to send any API requests.
5. **Group Name Validation:** Ensure the `groupName` field in both Single and Bulk modes handles special characters gracefully and trims leading/trailing whitespace before sending to the API.
6. **Password Visibility:** Include a "show/hide" eye icon for all password input fields in the Single User mode.