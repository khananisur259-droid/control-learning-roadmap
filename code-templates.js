(function () {
  "use strict";

  function T(title, language, summary, reusable, adapt, code, explanation, sources) {
    return { title, language, summary, reusable, adapt, code, explanation, sources };
  }

  const cmsisPid = { label: "ARM CMSIS-DSP PID 控制器", url: "https://arm-software.github.io/CMSIS-DSP/latest/group__PID.html" };
  const rosAngles = { label: "ROS angles 角度工具", url: "https://docs.ros.org/en/rolling/p/angles/" };
  const rosDiff = { label: "ROS 2 diff_drive_controller", url: "https://control.ros.org/rolling/doc/ros2_controllers/diff_drive_controller/doc/userdoc.html" };
  const nav2Pursuit = { label: "Nav2 Regulated Pure Pursuit", url: "https://docs.nav2.org/configuration/packages/configuring-regulated-pp.html" };
  const pythonHeap = { label: "Python 官方 heapq 文档", url: "https://docs.python.org/3/library/heapq.html" };
  const kalmanPaper = { label: "Welch & Bishop 卡尔曼滤波公开教材", url: "https://www.cs.unc.edu/~welch/media/pdf/kalman_intro.pdf" };

  const templates = {};

  templates["s02-schedule"] = [T(
    "无阻塞多周期任务调度器", "C", "用同一个毫秒时基安排不同频率任务，任何任务都不能在内部长时间等待。",
    "时间比较和任务分频框架可直接复用。",
    "把 millis()、control_task() 等函数替换为你的芯片驱动；控制周期必须与 PID 参数记录一致。",
`#include <stdint.h>
#include <stdbool.h>

// 由硬件定时器每 1 ms 自增。中断里只计时，不做控制和显示。
volatile uint32_t g_ms = 0;

static bool time_reached(uint32_t now, uint32_t deadline)
{
    // 使用有符号差值，可正确处理 uint32_t 计时器回绕。
    return (int32_t)(now - deadline) >= 0;
}

void scheduler_run(void)
{
    static uint32_t next_control = 0;
    static uint32_t next_telemetry = 0;
    static uint32_t next_display = 0;
    const uint32_t now = g_ms;

    if (time_reached(now, next_control)) {
        next_control += 10;      // 100 Hz 控制环
        control_task(0.010f);   // 明确传入真实周期，单位：秒
    }

    if (time_reached(now, next_telemetry)) {
        next_telemetry += 20;    // 50 Hz 遥测
        telemetry_task();
    }

    if (time_reached(now, next_display)) {
        next_display += 200;     // 5 Hz 显示，避免拖慢控制
        display_task();
    }
}`,
    ["任务错过一次截止时间后仍按原时间轴推进，避免执行耗时导致周期持续漂移。", "中断只产生时间基准；控制、通信和显示放在主循环执行。"],
    [{ label: "TI MSPM0 SDK 官方文档入口", url: "https://software-dl.ti.com/msp430/esd/MSPM0-SDK/latest/docs/english/index.html" }]
  )];

  templates["s02-protocol"] = [T(
    "带长度与 CRC16 的串口接收状态机", "C", "逐字节恢复数据帧，乱码、断线和超长帧只会丢弃当前帧，不会阻塞主循环。",
    "状态机、长度检查和 CRC 更新函数可复用。",
    "根据协议修改帧头、最大负载、CRC 字节序和 frame_ready()；UART 中断只调用 parser_push()。",
`#include <stdint.h>
#include <stddef.h>

#define FRAME_MAX 64u

typedef enum { WAIT_AA, WAIT_55, WAIT_LEN, READ_DATA, READ_CRC_H, READ_CRC_L } RxState;
typedef struct {
    RxState state;
    uint8_t len;
    uint8_t index;
    uint8_t data[FRAME_MAX];
    uint16_t crc;
    uint16_t received_crc;
} FrameParser;

static uint16_t crc16_ccitt_update(uint16_t crc, uint8_t byte)
{
    crc ^= (uint16_t)byte << 8;
    for (uint8_t i = 0; i < 8; ++i)
        crc = (crc & 0x8000u) ? (uint16_t)((crc << 1) ^ 0x1021u) : (uint16_t)(crc << 1);
    return crc;
}

void parser_push(FrameParser *p, uint8_t byte)
{
    switch (p->state) {
    case WAIT_AA:
        if (byte == 0xAAu) p->state = WAIT_55;
        break;
    case WAIT_55:
        p->state = (byte == 0x55u) ? WAIT_LEN : WAIT_AA;
        break;
    case WAIT_LEN:
        if (byte == 0u || byte > FRAME_MAX) { p->state = WAIT_AA; break; }
        p->len = byte; p->index = 0u;
        p->crc = crc16_ccitt_update(0xFFFFu, byte);
        p->state = READ_DATA;
        break;
    case READ_DATA:
        p->data[p->index++] = byte;
        p->crc = crc16_ccitt_update(p->crc, byte);
        if (p->index == p->len) p->state = READ_CRC_H;
        break;
    case READ_CRC_H:
        p->received_crc = (uint16_t)byte << 8;
        p->state = READ_CRC_L;
        break;
    case READ_CRC_L:
        p->received_crc |= byte;
        if (p->received_crc == p->crc) frame_ready(p->data, p->len);
        p->state = WAIT_AA;
        break;
    }
}`,
    ["解析器一次只处理一个字节，因此不会出现无上限 while 等待回包。", "长度先检查再写数组，避免坏数据造成越界。", "CRC 参数必须与发送端完全一致。"],
    [{ label: "CRC Catalogue: CRC-16/CCITT-FALSE 参数", url: "https://reveng.sourceforge.io/crc-catalogue/16.htm#crc.cat.crc-16-ibm-3740" }]
  )];

  templates["s03-encoder"] = [T(
    "增量编码器速度换算", "C", "用固定采样周期内的计数差计算轴转速，保留方向。",
    "计数差、转每秒和 RPM 的换算关系可直接复用。",
    "填写每圈实际计数 counts_per_rev 和减速比；确认计数值是电机轴还是输出轴；若单周期可能跨越半个计数器量程，改用更宽计数器。",
`#include <stdint.h>

typedef struct {
    uint16_t last_count;
    float rpm;
} EncoderSpeed;

float encoder_update_rpm(EncoderSpeed *s,
                         uint16_t now_count,
                         float counts_per_output_rev,
                         float dt_s)
{
    // 16 位减法后转成 int16_t，可处理一次正常回绕。
    // 前提：单周期计数变化绝对值必须小于 32768。
    const int16_t delta = (int16_t)(now_count - s->last_count);
    s->last_count = now_count;

    const float rev_per_s = (float)delta / counts_per_output_rev / dt_s;
    s->rpm = rev_per_s * 60.0f;
    return s->rpm;
}

// 例：四倍频后输出轴每圈 1560 个计数，采样周期 10 ms。
// float rpm = encoder_update_rpm(&enc, timer_count, 1560.0f, 0.010f);`,
    ["PPR、CPR、四倍频和减速比必须先统一成“输出轴每圈计数”。", "低速跳动大时可延长测量窗或改用 T 法，但不能只靠大低通掩盖量化误差。"],
    [{ label: "TI MSPM0 SDK Encoder 官方示例索引", url: "https://software-dl.ti.com/msp430/esd/MSPM0-SDK/latest/docs/english/index.html" }]
  )];

  templates["algo-pid"] = templates["p2"] = [T(
    "带积分限幅和测量微分的位置式 PID", "C", "适合速度、位置或角度闭环。D 对测量值求导，可减小目标突变引起的微分冲击。",
    "PID 结构、dt 处理、积分限幅和输出限幅可直接复用。",
    "按物理量选择 Kp/Ki/Kd、输出范围和积分范围；measurement 必须是真实反馈；调用周期 dt_s 必须准确且大于 0。",
`#include <stdbool.h>

typedef struct {
    float kp, ki, kd;
    float integral;
    float integral_min, integral_max;
    float output_min, output_max;
    float last_measurement;
    bool first;
} PID;

static float clampf(float x, float lo, float hi)
{
    return x < lo ? lo : (x > hi ? hi : x);
}

float pid_update(PID *p, float setpoint, float measurement, float dt_s)
{
    if (dt_s <= 0.0f) return 0.0f;

    const float error = setpoint - measurement;
    const float derivative = p->first ? 0.0f
        : -(measurement - p->last_measurement) / dt_s;
    p->first = false;
    p->last_measurement = measurement;

    const float next_i = clampf(p->integral + error * dt_s,
                                p->integral_min, p->integral_max);
    const float unsat = p->kp * error + p->ki * next_i + p->kd * derivative;
    const float output = clampf(unsat, p->output_min, p->output_max);

    // 未饱和时正常积分；饱和时只允许误差把输出拉回可控范围。
    if (unsat == output ||
        (output >= p->output_max && error < 0.0f) ||
        (output <= p->output_min && error > 0.0f)) {
        p->integral = next_i;
    }
    return output;
}`,
    ["Kp 处理当前误差，Ki 消除持续偏差，Kd 根据变化趋势提前制动。", "先验证反馈方向，再只调 P；需要消除稳态误差时再加 I，需要抑制快速变化和超调时再加 D。", "输出长期顶在限幅上时，继续增大 PID 通常不是正确解决办法。"],
    [cmsisPid]
  )];

  templates["s05-kinematics"] = [T(
    "差速底盘线速度/角速度分配", "C", "把车体目标线速度 v 和角速度 w 换算成左右轮目标线速度。",
    "差速运动学公式可直接复用。",
    "wheel_track_m 使用左右轮接地点中心距；确认左正右正都代表车前进；再把 m/s 转成各轮控制器使用的 RPM。",
`typedef struct { float left_mps; float right_mps; } WheelTarget;

WheelTarget differential_mix(float linear_mps,
                             float angular_rad_s,
                             float wheel_track_m)
{
    WheelTarget out;
    // 正角速度约定为逆时针：左轮慢、右轮快。
    out.left_mps  = linear_mps - angular_rad_s * wheel_track_m * 0.5f;
    out.right_mps = linear_mps + angular_rad_s * wheel_track_m * 0.5f;
    return out;
}

float mps_to_rpm(float speed_mps, float wheel_radius_m)
{
    const float pi = 3.14159265358979323846f;
    return speed_mps * 60.0f / (2.0f * pi * wheel_radius_m);
}`,
    ["线速度决定两轮共同部分，角速度决定左右轮差值。", "轮径和轮距标定误差会直接变成直线与转弯误差。"],
    [rosDiff]
  )];

  templates["s05-weight"] = templates["p4"] = [T(
    "多路循迹传感器加权偏差", "C", "把任意数量的离散循迹传感器变成连续横向偏差，供循迹外环使用；八路只是配置示例。",
    "加权平均结构和丢线返回方式可直接复用，传感器数量由调用参数决定。",
    "必须按实际安装位置填写 position 数组，并核对数组顺序和黑白极性；权重不是 PID 参数；模拟量应先归一化，丢线必须单独处理。",
`#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

typedef struct { bool line_seen; float error; } LineResult;

LineResult line_error_weighted(const uint8_t black[],
                               const float position[],
                               size_t sensor_count,
                               float last_error)
{
    // black[i]：该路是否检测到黑线，检测到为1，否则为0。
    // position[i]：该传感器相对车体中心的横向位置，单位自定但必须统一。
    float weighted_sum = 0.0f;
    size_t active = 0u;

    for (size_t i = 0u; i < sensor_count; ++i) {
        if (black[i]) {
            weighted_sum += position[i];
            ++active;
        }
    }

    if (active == 0u) {
        // 丢线时不要伪造“误差为0”，保留最后方向交给恢复逻辑。
        LineResult lost = {false, last_error};
        return lost;
    }
    LineResult ok = {true, weighted_sum / (float)active};
    return ok;
}

// 五路传感器示例。更换为三路、六路或八路时，只改数组和数量。
static const float sensor_position[5] = {-2.0f, -1.0f, 0.0f, 1.0f, 2.0f};

void example(void)
{
    const uint8_t black[5] = {0u, 1u, 1u, 0u, 0u};
    LineResult result = line_error_weighted(
        black, sensor_position, 5u, 0.0f);
    (void)result;
}`,
    ["传感器路数不是算法限制，数组长度和 sensor_count 必须一致。", "多个探头同时压线时取横向位置平均，偏差比大量 if-else 更连续。", "全白不是中心，应进入明确的丢线状态。", "十字线、起停横线等特殊图形应由状态机另行判断。"],
    [{ label: "Pololu QTR 反射传感器官方文档", url: "https://www.pololu.com/docs/0J19/all" }]
  )];

  templates["s05-lost"] = [T(
    "带超时保护的丢线恢复", "C", "短时丢线沿最后误差方向搜索，超时后停车，避免无限盲走。",
    "状态切换和超时保护可复用。",
    "恢复转向符号、搜索力度和超时时间必须在低速实车验证；恢复输出应进入轮速目标而不是绕过速度环直接打满 PWM。",
`typedef enum { TRACKING, SEARCHING, LOST_STOP } LineState;

float line_recovery_update(LineState *state,
                           bool line_seen,
                           float line_error,
                           uint32_t now_ms)
{
    static uint32_t lost_since_ms = 0;
    static float last_direction = 1.0f;

    if (line_seen) {
        *state = TRACKING;
        if (line_error > 0.2f) last_direction = 1.0f;
        if (line_error < -0.2f) last_direction = -1.0f;
        return line_error;
    }

    if (*state == TRACKING) {
        *state = SEARCHING;
        lost_since_ms = now_ms;
    }
    if ((uint32_t)(now_ms - lost_since_ms) > 500u) {
        *state = LOST_STOP;
        return 0.0f;
    }
    return 8.0f * last_direction; // 搜索转向量，必须按底盘适配
}`,
    ["恢复方向来自最后一次可信偏差，而不是随机选择。", "恢复有明确超时和停车状态，传感器故障时不会一直冲出赛道。"],
    []
  )];

  templates["s06-wrap"] = templates["p5"] = [T(
    "角度归一化与最短路径误差", "C", "保证目标 179°、实际 -179° 时误差是 -2°，而不是 358°。",
    "角度回绕函数可直接复用。",
    "统一角度正方向和单位；若系统使用弧度，把 180/360 换成 pi/2pi。",
`float wrap_deg_180(float angle_deg)
{
    while (angle_deg > 180.0f) angle_deg -= 360.0f;
    while (angle_deg <= -180.0f) angle_deg += 360.0f;
    return angle_deg;
}

float shortest_angle_error_deg(float target_deg, float actual_deg)
{
    return wrap_deg_180(target_deg - actual_deg);
}

// 示例：target=179, actual=-179，结果为 -2 度。
// float error = shortest_angle_error_deg(179.0f, -179.0f);`,
    ["必须先做角度回绕，再把误差送入 PID。", "最短路径只解决方向选择，不替代减速、限幅和停止判定。"],
    [rosAngles]
  )];

  templates["s06-profile"] = templates["algo-profile"] = [T(
    "目标值斜率限制器", "C", "限制每秒最大上升和下降量，避免速度或角度目标瞬间跳变。",
    "斜率限制器可用于速度、角度和电流目标。",
    "rise_per_s 和 fall_per_s 的单位必须与目标值每秒变化量一致；真正的 S 曲线还需要继续限制加速度变化率。",
`float slew_rate_limit(float target, float current,
                      float rise_per_s, float fall_per_s, float dt_s)
{
    const float delta = target - current;
    const float up = rise_per_s * dt_s;
    const float down = fall_per_s * dt_s;

    if (delta > up) return current + up;
    if (delta < -down) return current - down;
    return target;
}

// 10 ms 调用一次，最高每秒增加 20 RPM、减少 30 RPM。
// cmd = slew_rate_limit(request, cmd, 20.0f, 30.0f, 0.010f);`,
    ["这是一阶运动约束，适合先解决目标阶跃。", "若机构仍因加速度突变而冲击，再升级为限制加加速度的 S 曲线。"],
    []
  )];

  templates["s06-fsm"] = templates["emb-fsm"] = [T(
    "非阻塞任务状态机", "C", "每次调用只推进一步，等待条件用时间和传感器判断，不用 delay。",
    "状态枚举、进入状态函数和超时结构可直接复用。",
    "替换 motor_set()、line_marker_seen() 等硬件接口；每个状态都要定义完成、超时和故障出口。",
`typedef enum { IDLE, STARTING, RUNNING, BRAKING, DONE, FAULT } TaskState;

typedef struct {
    TaskState state;
    uint32_t entered_ms;
} TaskFsm;

static void enter_state(TaskFsm *f, TaskState next, uint32_t now_ms)
{
    f->state = next;
    f->entered_ms = now_ms;
}

void task_update(TaskFsm *f, uint32_t now_ms)
{
    const uint32_t elapsed = now_ms - f->entered_ms;
    switch (f->state) {
    case IDLE:
        motor_set(0.0f);
        if (start_pressed()) enter_state(f, STARTING, now_ms);
        break;
    case STARTING:
        motor_set(start_profile(elapsed));
        if (elapsed >= 1000u) enter_state(f, RUNNING, now_ms);
        break;
    case RUNNING:
        follow_line();
        if (line_marker_seen()) enter_state(f, BRAKING, now_ms);
        if (sensor_fault()) enter_state(f, FAULT, now_ms);
        break;
    case BRAKING:
        motor_set(stop_profile(elapsed));
        if (elapsed >= 500u) enter_state(f, DONE, now_ms);
        break;
    case DONE:  motor_set(0.0f); break;
    case FAULT: emergency_stop(); break;
    }
}`,
    ["状态只描述任务阶段，PID 仍负责各状态中的连续控制。", "所有等待都通过再次调用 task_update() 完成，因此通信和急停仍能响应。"],
    []
  )];

  templates["s07-fresh"] = templates["pit-oldframe"] = [T(
    "只在视觉新帧到达时更新外环", "C", "控制循环可以比相机快，但同一帧不能重复计算位置微分。",
    "帧序号与时间戳门控结构可直接复用。",
    "相机必须发送递增 frame_id 和采集时间；跨设备时间戳无法统一时，至少在主控收到新帧时记录本地时间。",
`typedef struct {
    uint32_t frame_id;
    uint32_t capture_us;
    float x;
    bool valid;
} VisionSample;

void vision_outer_loop(const VisionSample *v)
{
    static uint32_t last_id = 0;
    static uint32_t last_us = 0;
    static float held_target_speed = 0.0f;

    if (v->valid && v->frame_id != last_id) {
        const float dt = (last_us == 0u) ? 0.0f
            : (float)(v->capture_us - last_us) * 1e-6f;
        if (dt > 0.0f && dt < 0.2f)
            held_target_speed = position_pid_update(v->x, dt);
        last_id = v->frame_id;
        last_us = v->capture_us;
    }

    // 电机内环仍按固定高频运行，使用最近一次有效外环目标。
    motor_speed_loop(held_target_speed);
}`,
    ["视觉测量频率和电机命令刷新频率不是一回事。", "新帧才更新微分；帧间期间保持上一次外环输出。"],
    []
  )];

  templates["s07-cascade"] = templates["algo-cascade"] = [T(
    "位置外环 + 速度内环调度框架", "C", "外环把位置误差变成目标速度，内环让真实速度跟随目标速度。",
    "串级环路的数据流和频率关系可复用。",
    "先单独调稳速度内环；外环频率通常不高于测量更新频率；两层输出都必须限幅。",
`typedef struct {
    PID position_pid;
    PID speed_pid;
    float target_speed;
} CascadeControl;

void cascade_update(CascadeControl *c,
                    bool new_position_sample,
                    float target_position,
                    float actual_position,
                    float position_dt,
                    float actual_speed,
                    float control_dt)
{
    // 外环只在新的位置测量到达时更新。
    if (new_position_sample) {
        c->target_speed = pid_update(&c->position_pid,
                                     target_position,
                                     actual_position,
                                     position_dt);
    }

    // 内环按固定控制周期持续执行。
    const float actuator_cmd = pid_update(&c->speed_pid,
                                          c->target_speed,
                                          actual_speed,
                                          control_dt);
    actuator_set(actuator_cmd);
}`,
    ["外环决定“该以多快接近目标”，内环决定“执行器用多大作用跟上速度”。", "内环带宽应明显高于外环；内环没稳时不要调外环。"],
    [cmsisPid]
  )];

  templates["s08-speed-est"] = templates["algo-regression"] = [T(
    "不等间隔多帧最小二乘速度估计", "C", "根据真实时间戳拟合位置随时间的斜率，比固定相邻帧差分更抗抖。",
    "最小二乘斜率公式可直接复用。",
    "位置和时间必须使用一致单位；窗口越长越平滑但延迟越大，快速制动场景从 3 到 5 帧开始验证。",
`#include <stddef.h>

float fit_velocity(const float position[], const float time_s[], size_t n)
{
    if (n < 2u) return 0.0f;

    float mean_t = 0.0f, mean_x = 0.0f;
    for (size_t i = 0; i < n; ++i) {
        mean_t += time_s[i];
        mean_x += position[i];
    }
    mean_t /= (float)n;
    mean_x /= (float)n;

    float numerator = 0.0f, denominator = 0.0f;
    for (size_t i = 0; i < n; ++i) {
        const float dt = time_s[i] - mean_t;
        numerator += dt * (position[i] - mean_x);
        denominator += dt * dt;
    }
    return denominator > 1e-9f ? numerator / denominator : 0.0f;
}`,
    ["函数输出是拟合直线斜率，即位置单位/秒。", "必须使用真实帧时间戳，不能假设相机永远固定帧率。"],
    [{ label: "NIST 线性最小二乘说明", url: "https://www.itl.nist.gov/div898/handbook/pmd/section1/pmd141.htm" }]
  )];

  templates["s08-feedforward"] = templates["algo-feedforward"] = [T(
    "车辆加速度到摆杆倾角前馈", "C", "用倾角产生的重力分量提前抵消车体纵向加速度。",
    "theta=atan2(-a,g) 的物理关系可复用。",
    "IMU 加速度必须去重力、确认车头轴和正方向；机构角度与电机角度可能有传动比；前馈限幅必须小于机械安全角。",
`#include <math.h>

float acceleration_feedforward_deg(float vehicle_accel_mps2,
                                   float max_angle_deg)
{
    const float g = 9.80665f;
    const float rad_to_deg = 57.2957795f;

    // 坐标约定：车向前加速为正，杆向前低为负角。
    // 若实车方向相反，只改这里的符号，不要靠 PID 硬顶。
    float angle = atan2f(-vehicle_accel_mps2, g) * rad_to_deg;
    if (angle > max_angle_deg) angle = max_angle_deg;
    if (angle < -max_angle_deg) angle = -max_angle_deg;
    return angle;
}

// 最终目标 = 位置/速度反馈角 + 前馈角。
// target_angle = feedback_angle + acceleration_feedforward_deg(ax, 3.0f);`,
    ["前馈不等待钢球偏移，反馈 PID 负责模型误差和其他扰动。", "IMU 原始加速度常包含重力、振动和安装误差，不能不处理就直接代入。"],
    [{ label: "NXP AN3461 加速度计倾角计算", url: "https://www.nxp.com/docs/en/application-note/AN3461.pdf" }]
  )];

  templates["algo-mean"] = [T(
    "固定长度滑动均值", "C", "用环形缓冲维护最近 N 个样本，单次更新时间为 O(1)。",
    "环形缓冲和运行和可直接复用。",
    "N 越大延迟越高；启动阶段 count 未满时必须除以实际样本数。",
`#define MEAN_N 5u

typedef struct {
    float buf[MEAN_N];
    float sum;
    unsigned index;
    unsigned count;
} MovingMean;

float moving_mean_update(MovingMean *f, float sample)
{
    f->sum -= f->buf[f->index];
    f->buf[f->index] = sample;
    f->sum += sample;
    f->index = (f->index + 1u) % MEAN_N;
    if (f->count < MEAN_N) ++f->count;
    return f->sum / (float)f->count;
}`,
    ["均值能降低随机噪声，但会把突变摊到整个窗口。", "控制闭环中要同时观察平滑程度和新增延迟。"],
    []
  )];

  templates["algo-median"] = [T(
    "三点中值滤波", "C", "去除单帧孤立尖峰，同时只引入很短窗口。",
    "median3() 可直接复制到传感器预处理。",
    "它不能消除连续抖动；必须先确认三个输入按时间顺序来自连续样本。",
`static float median3(float a, float b, float c)
{
    if (a > b) { float t = a; a = b; b = t; }
    if (b > c) { float t = b; b = c; c = t; }
    if (a > b) { float t = a; a = b; b = t; }
    return b;
}

// x0 最旧、x2 最新。输出三个值中的中间值。
// filtered = median3(x0, x1, x2);`,
    ["中值滤波对孤立异常点有效，不会像均值那样被极大值明显拉偏。", "窗口固定为 3，适合先验证是否真的是单帧跳点。"],
    []
  )];

  templates["algo-lowpass"] = [T(
    "按真实 dt 计算的一阶低通", "C", "用时间常数 tau 定义滤波强度，采样周期变化时响应仍可解释。",
    "离散一阶低通公式可直接复用。",
    "sample 和 state 单位一致；tau 越大越平滑但越慢；dt 异常大时应丢弃或重置而不是照算。",
`typedef struct { float y; int initialized; } LowPass;

float lowpass_update(LowPass *f, float sample, float tau_s, float dt_s)
{
    if (!f->initialized) {
        f->y = sample;
        f->initialized = 1;
        return f->y;
    }
    if (dt_s <= 0.0f || tau_s <= 0.0f) return f->y;

    const float alpha = dt_s / (tau_s + dt_s);
    f->y += alpha * (sample - f->y);
    return f->y;
}`,
    ["alpha 不应在采样周期变化后继续写死。", "调滤波必须同时记录噪声幅度、相位延迟和最终控制误差。"],
    []
  )];

  templates["algo-complement"] = [T(
    "陀螺仪 + 加速度计互补滤波", "C", "陀螺仪负责短时变化，加速度倾角负责长期基准。",
    "互补融合主公式可复用。",
    "gyro_rate 必须去零偏并统一成度/秒；acc_angle 只在线加速度较小时可信；三维姿态和大角运动应使用四元数方案。",
`typedef struct { float angle_deg; int initialized; } Complementary;

float complementary_update(Complementary *f,
                           float gyro_rate_deg_s,
                           float acc_angle_deg,
                           float dt_s,
                           float alpha)
{
    if (!f->initialized) {
        f->angle_deg = acc_angle_deg;
        f->initialized = 1;
    }
    const float gyro_prediction = f->angle_deg + gyro_rate_deg_s * dt_s;
    f->angle_deg = alpha * gyro_prediction + (1.0f - alpha) * acc_angle_deg;
    return f->angle_deg;
}

// 100 Hz 下可从 alpha=0.98 开始，但必须根据噪声和动态验证。
// angle = complementary_update(&f, gyro, acc_angle, 0.01f, 0.98f);`,
    ["alpha 越接近 1 越相信陀螺仪，响应快但长期会漂。", "车辆强加速时加速度计不再只测重力，此时 acc_angle 会被污染。"],
    [{ label: "NXP AN3461 倾角与加速度限制", url: "https://www.nxp.com/docs/en/application-note/AN3461.pdf" }]
  )];

  templates["algo-kf"] = templates["s09-estimation"] = [T(
    "一维标量卡尔曼滤波", "C", "融合“上一时刻状态预测”和“当前带噪测量”，适合先理解 KF 的预测与校正。",
    "标量 KF 的预测/校正公式可直接复用。",
    "q 是过程噪声方差，r 是测量噪声方差，不是随便的平滑系数；多状态系统应建立矩阵模型。",
`typedef struct {
    float x;  // 状态估计
    float p;  // 估计误差方差
    float q;  // 每步过程噪声方差
    float r;  // 测量噪声方差
} Kalman1D;

float kalman1d_update(Kalman1D *k, float measurement)
{
    // 预测：假设状态本步保持不变，但不确定性增加。
    k->p += k->q;

    // 校正：测量越可信(r小)，增益越接近1。
    const float gain = k->p / (k->p + k->r);
    k->x += gain * (measurement - k->x);
    k->p *= (1.0f - gain);
    return k->x;
}`,
    ["这是一维恒值模型，只适合入门或变化较慢的量。", "若要同时估计位置和速度，应使用至少二维状态 [位置, 速度] 及对应状态转移矩阵。"],
    [kalmanPaper]
  )];

  templates["algo-astar"] = templates["p8"] = [T(
    "四邻域网格 A*", "Python", "在占据栅格中寻找从起点到终点的最低代价路径。",
    "搜索框架可直接在仿真和离线路径规划中运行。",
    "grid 中 0 表示可通行、1 表示障碍；真实机器人还需膨胀障碍、坐标转换、路径平滑和局部避障。",
`from heapq import heappush, heappop

def astar(grid, start, goal):
    rows, cols = len(grid), len(grid[0])
    def h(p):
        # 四邻域且每步代价为1时，曼哈顿距离不会高估真实代价。
        return abs(p[0] - goal[0]) + abs(p[1] - goal[1])

    open_heap = [(h(start), 0, start)]
    came_from = {}
    best_g = {start: 0}

    while open_heap:
        _, g, current = heappop(open_heap)
        if g != best_g.get(current):
            continue  # 跳过堆中已经过期的较差记录
        if current == goal:
            path = [current]
            while current in came_from:
                current = came_from[current]
                path.append(current)
            return path[::-1]

        r, c = current
        for nxt in ((r-1,c), (r+1,c), (r,c-1), (r,c+1)):
            nr, nc = nxt
            if not (0 <= nr < rows and 0 <= nc < cols):
                continue
            if grid[nr][nc] != 0:
                continue
            new_g = g + 1
            if new_g < best_g.get(nxt, float("inf")):
                best_g[nxt] = new_g
                came_from[nxt] = current
                heappush(open_heap, (new_g + h(nxt), new_g, nxt))
    return None`,
    ["A* 的 f=g+h；启发函数不高估时可以保证最优性。", "这段只解决全局网格搜索，不负责底盘动力学和实时避障。"],
    [pythonHeap]
  )];

  templates["algo-pure"] = [T(
    "Pure Pursuit 曲率与差速轮速目标", "C", "选取前视点后计算跟踪曲率，再换算成左右轮目标速度。",
    "曲率公式和差速分配可直接复用。",
    "lookahead_x/y 必须已经转换到车体坐标系；前视距离过小会抖，过大会切弯；速度高时通常应增大前视距离。",
`typedef struct { float left_mps; float right_mps; } WheelTarget;

WheelTarget pure_pursuit(float linear_mps,
                         float lookahead_x_m,
                         float lookahead_y_m,
                         float wheel_track_m)
{
    const float ld2 = lookahead_x_m * lookahead_x_m
                    + lookahead_y_m * lookahead_y_m;
    const float curvature = ld2 > 1e-6f ? 2.0f * lookahead_y_m / ld2 : 0.0f;
    const float angular = linear_mps * curvature;

    WheelTarget out;
    out.left_mps  = linear_mps - angular * wheel_track_m * 0.5f;
    out.right_mps = linear_mps + angular * wheel_track_m * 0.5f;
    return out;
}`,
    ["前视点必须在车体坐标系中，x 向前、y 向左或向右的符号要统一。", "输出是轮速目标，应交给已经调好的左右轮速度环。"],
    [nav2Pursuit, rosDiff]
  )];

  templates["pit-bandwidth"] = [T(
    "UART 遥测带宽核算", "C", "在加通道前计算串口占用率，避免波形延迟和错帧。",
    "8N1 串口每字节约 10 bit 的核算公式可直接复用。",
    "若协议包含转义、文本格式、无线重传或额外帧头，需要把真实开销加进去；建议占用率不超过 70%。",
`#include <stdbool.h>

bool telemetry_bandwidth_ok(unsigned baud,
                            unsigned bytes_per_frame,
                            float frames_per_second)
{
    // 8N1：1起始位 + 8数据位 + 1停止位 = 每字节10 bit。
    const float required_bps = bytes_per_frame * 10.0f * frames_per_second;
    const float utilization = required_bps / (float)baud;
    return utilization <= 0.70f; // 至少留30%余量给抖动、命令和协议开销
}

// 20个float(80B) + 4B帧尾，50Hz，115200波特率：
// utilization = 84 * 10 * 50 / 115200 = 36.5%，可接受。`,
    ["COM 口存在只证明 USB 芯片被枚举，不证明 MCU 正在发数据。", "JustFloat 帧中不能混发 printf 文本，否则任何一个文本字节都会破坏帧边界。"],
    []
  )];

  window.CODE_TEMPLATES = templates;
})();
