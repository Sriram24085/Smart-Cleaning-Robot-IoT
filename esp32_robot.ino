/*
 * ============================================================
 *  Smart Water Cleaning Robot — ESP32 Firmware
 *  Integrates: ThingSpeak | Blynk | Motor & Servo Control
 * ============================================================
 *
 *  Libraries Required (install via Arduino Library Manager):
 *    - Blynk (by Volodymyr Shymanskyy)  >= 1.3.2
 *    - HTTPClient (built-in ESP32 core)
 *    - ESP32Servo (by Kevin Harrington)
 *
 *  Wiring:
 *    Waste Ultrasonic (HC-SR04):
 *      TRIG → GPIO 5  | ECHO → GPIO 18
 *    Obstacle Ultrasonic (HC-SR04):
 *      TRIG → GPIO 19 | ECHO → GPIO 21
 *    Motor RPM Sensor (IR/Hall):
 *      SIGNAL → GPIO 34 (interrupt-capable)
 *    Motor IN1/IN2 (L298N or similar):
 *      IN1 → GPIO 25  | IN2 → GPIO 26
 *      IN3 → GPIO 27  | IN4 → GPIO 14
 *    Servo:
 *      PWM → GPIO 13
 *
 *  Fill your credentials in the CONFIG section below.
 * ============================================================
 */

// ─── Blynk config MUST come before #include <BlynkSimpleEsp32.h> ───
#define BLYNK_TEMPLATE_ID   "YOUR_BLYNK_TEMPLATE_ID"
#define BLYNK_TEMPLATE_NAME "WaterRobot"
#define BLYNK_AUTH_TOKEN    "YOUR_BLYNK_AUTH_TOKEN"
#define BLYNK_PRINT Serial

#include <WiFi.h>
#include <HTTPClient.h>
#include <BlynkSimpleEsp32.h>
#include <ESP32Servo.h>

// ─────────────────────────────────────────
//  ▶ CONFIG — fill these before flashing
// ─────────────────────────────────────────
const char* WIFI_SSID       = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD   = "YOUR_WIFI_PASSWORD";

// ThingSpeak
const char* TS_API_KEY      = "YOUR_THINGSPEAK_WRITE_API_KEY";
const char* TS_SERVER       = "http://api.thingspeak.com";
const unsigned long TS_CH   = 0;           // your channel id (unused in HTTP POST)

// ─────────────────────────────────────────
//  PIN DEFINITIONS
// ─────────────────────────────────────────
// Waste ultrasonic
#define WASTE_TRIG   5
#define WASTE_ECHO  18

// Obstacle ultrasonic
#define OBS_TRIG    19
#define OBS_ECHO    21

// RPM sensor (interrupt pin)
#define RPM_PIN     34

// Motor driver (L298N)
#define MOTOR_IN1   25
#define MOTOR_IN2   26
#define MOTOR_IN3   27
#define MOTOR_IN4   14

// Servo
#define SERVO_PIN   13

// ─────────────────────────────────────────
//  BLYNK VIRTUAL PINS
// ─────────────────────────────────────────
#define V_WASTE_DIST    V5
#define V_OBS_DIST      V6
#define V_RPM           V7
#define V_MOTOR_STATUS  V8
#define V_SERVO_STATUS  V9

// ─────────────────────────────────────────
//  TIMING
// ─────────────────────────────────────────
#define THINGSPEAK_INTERVAL_MS  15000UL   // 15 s (ThingSpeak free tier limit)
#define RPM_CALC_INTERVAL_MS     1000UL   // recalculate RPM every 1 s

// ─────────────────────────────────────────
//  GLOBALS
// ─────────────────────────────────────────
Servo servo;
BlynkTimer timer;

volatile unsigned long pulseCount    = 0;
unsigned long          lastRpmTime   = 0;
unsigned long          lastTsTime    = 0;

float wasteDist    = 0.0f;
float obsDist      = 0.0f;
float motorRPM     = 0.0f;
bool  motorOn      = false;
bool  servoOpen    = false;   // false = 0°  true = 90°

// ─────────────────────────────────────────
//  ISR — count RPM pulses
// ─────────────────────────────────────────
void IRAM_ATTR onRpmPulse() {
  pulseCount++;
}

// ─────────────────────────────────────────
//  ULTRASONIC HELPER
// ─────────────────────────────────────────
float readUltrasonic(uint8_t trigPin, uint8_t echoPin) {
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);

  long duration = pulseIn(echoPin, HIGH, 30000); // 30 ms timeout
  if (duration == 0) return -1.0f;               // no echo
  return duration * 0.0343f / 2.0f;              // cm
}

// ─────────────────────────────────────────
//  RPM CALCULATION  (every 1 s)
// ─────────────────────────────────────────
void calcRPM() {
  unsigned long now = millis();
  if (now - lastRpmTime >= RPM_CALC_INTERVAL_MS) {
    noInterrupts();
    unsigned long count = pulseCount;
    pulseCount = 0;
    interrupts();

    // Assuming 1 pulse per revolution (adjust PULSES_PER_REV if needed)
    const uint8_t PULSES_PER_REV = 1;
    float elapsed_s = (now - lastRpmTime) / 1000.0f;
    motorRPM = (count / (float)PULSES_PER_REV) / elapsed_s * 60.0f;
    motorOn  = (motorRPM > 5.0f);
    lastRpmTime = now;
  }
}

// ─────────────────────────────────────────
//  READ SENSORS  (called by Blynk timer)
// ─────────────────────────────────────────
void readSensors() {
  wasteDist = readUltrasonic(WASTE_TRIG, WASTE_ECHO);
  obsDist   = readUltrasonic(OBS_TRIG,  OBS_ECHO);
  calcRPM();

  Serial.printf("[Sensors] Waste: %.1f cm | Obs: %.1f cm | RPM: %.0f | Motor: %s | Servo: %s\n",
    wasteDist, obsDist, motorRPM,
    motorOn   ? "ON"   : "OFF",
    servoOpen ? "Open" : "Closed");

  // ── Push to Blynk ──
  Blynk.virtualWrite(V_WASTE_DIST,   wasteDist);
  Blynk.virtualWrite(V_OBS_DIST,     obsDist);
  Blynk.virtualWrite(V_RPM,          motorRPM);
  Blynk.virtualWrite(V_MOTOR_STATUS, motorOn   ? "ON"   : "OFF");
  Blynk.virtualWrite(V_SERVO_STATUS, servoOpen ? "Open" : "Closed");
}

// ─────────────────────────────────────────
//  THINGSPEAK UPLOAD
// ─────────────────────────────────────────
void sendToThingSpeak() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = String(TS_SERVER) + "/update?api_key=" + TS_API_KEY
    + "&field1=" + String(wasteDist,  1)
    + "&field2=" + String(obsDist,    1)
    + "&field3=" + String(motorRPM,   0)
    + "&field4=" + String(motorOn   ? 1 : 0)
    + "&field5=" + String(servoOpen ? 1 : 0);

  http.begin(url);
  int code = http.GET();
  Serial.printf("[ThingSpeak] HTTP %d — %s\n", code, code > 0 ? "OK" : "FAIL");
  http.end();
}

// ─────────────────────────────────────────
//  MOTOR HELPERS
// ─────────────────────────────────────────
void motorForward() {
  digitalWrite(MOTOR_IN1, HIGH); digitalWrite(MOTOR_IN2, LOW);
  digitalWrite(MOTOR_IN3, HIGH); digitalWrite(MOTOR_IN4, LOW);
  motorOn = true;
  Serial.println("[Motor] FORWARD");
}

void motorLeft() {
  digitalWrite(MOTOR_IN1, LOW);  digitalWrite(MOTOR_IN2, HIGH);
  digitalWrite(MOTOR_IN3, HIGH); digitalWrite(MOTOR_IN4, LOW);
  motorOn = true;
  Serial.println("[Motor] LEFT");
}

void motorRight() {
  digitalWrite(MOTOR_IN1, HIGH); digitalWrite(MOTOR_IN2, LOW);
  digitalWrite(MOTOR_IN3, LOW);  digitalWrite(MOTOR_IN4, HIGH);
  motorOn = true;
  Serial.println("[Motor] RIGHT");
}

void motorStop() {
  digitalWrite(MOTOR_IN1, LOW); digitalWrite(MOTOR_IN2, LOW);
  digitalWrite(MOTOR_IN3, LOW); digitalWrite(MOTOR_IN4, LOW);
  motorOn = false;
  Serial.println("[Motor] STOP");
}

// ─────────────────────────────────────────
//  BLYNK WRITE HANDLERS  (control commands)
// ─────────────────────────────────────────
// V1 → direction joystick / button (0=Stop,1=Fwd,2=Left,3=Right)
BLYNK_WRITE(V1) {
  int cmd = param.asInt();
  switch (cmd) {
    case 1: motorForward(); break;
    case 2: motorLeft();    break;
    case 3: motorRight();   break;
    default: motorStop();   break;
  }
}

// V2 → servo toggle (0=Close, 1=Open)
BLYNK_WRITE(V2) {
  int val = param.asInt();
  if (val == 1) {
    servo.write(90);
    servoOpen = true;
    Serial.println("[Servo] OPEN (90°)");
  } else {
    servo.write(0);
    servoOpen = false;
    Serial.println("[Servo] CLOSED (0°)");
  }
  Blynk.virtualWrite(V_SERVO_STATUS, servoOpen ? "Open" : "Closed");
}

// ─────────────────────────────────────────
//  SETUP
// ─────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Serial.println("\n=== Smart Water Cleaning Robot ===");

  // ── Pin modes ──
  pinMode(WASTE_TRIG, OUTPUT); pinMode(WASTE_ECHO, INPUT);
  pinMode(OBS_TRIG,   OUTPUT); pinMode(OBS_ECHO,   INPUT);
  pinMode(RPM_PIN,    INPUT_PULLUP);
  pinMode(MOTOR_IN1,  OUTPUT); pinMode(MOTOR_IN2, OUTPUT);
  pinMode(MOTOR_IN3,  OUTPUT); pinMode(MOTOR_IN4, OUTPUT);
  motorStop();

  // ── Servo ──
  ESP32PWM::allocateTimer(0);
  servo.setPeriodHertz(50);
  servo.attach(SERVO_PIN, 500, 2400);
  servo.write(0);

  // ── RPM interrupt ──
  attachInterrupt(digitalPinToInterrupt(RPM_PIN), onRpmPulse, RISING);
  lastRpmTime = millis();

  // ── WiFi ──
  Serial.printf("[WiFi] Connecting to %s", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500); Serial.print(".");
  }
  Serial.printf("\n[WiFi] Connected — IP: %s\n", WiFi.localIP().toString().c_str());

  // ── Blynk ──
  Blynk.config(BLYNK_AUTH_TOKEN);
  Blynk.connect(3000);

  // ── Blynk timer: read sensors every 2 s ──
  timer.setInterval(2000L, readSensors);

  lastTsTime = millis();
  Serial.println("[Setup] Done. Starting main loop.");
}

// ─────────────────────────────────────────
//  LOOP
// ─────────────────────────────────────────
void loop() {
  Blynk.run();
  timer.run();

  // ThingSpeak upload (rate-limited to every 15 s)
  if (millis() - lastTsTime >= THINGSPEAK_INTERVAL_MS) {
    sendToThingSpeak();
    lastTsTime = millis();
  }

  // Obstacle / waste safety checks
  if (obsDist > 0 && obsDist < 20.0f) {
    motorStop();
    Blynk.logEvent("obstacle_warning", "⚠️ Obstacle < 20 cm! Robot stopped.");
  }
}
