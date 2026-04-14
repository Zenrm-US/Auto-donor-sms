1.Connects to MongoDB
2. Finds eligible donations
3. Applies validation rules
4. Generates secure short URL using MWL API
5. Sends SMS through Twilio
6. Logs results and exports CSV report
## Rules
SMS is sent only when:
- Donation is NEW (within configured days)
- StageName = Closed Won
- Donation Source = Fundraising App
- Contact exists and has a phone number
- Contact is not excluded
## Installation
npm install
## Configuration
 create .env and fill in credentials.
## Running the Script
node index.js
## Output
A CSV report will be generated:( ın the same fıle you wıll use for packages)
donation_sms_report.csv
It includes:
- donation id
- contact id
- phone number
- eligibility status
- generated URL
- SMS status
## Safety
DRY_RUN=true will simulate SMS without sending.
MAX_SMS limits number of messages sent per run.
