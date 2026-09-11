#pragma once

namespace dusk::mouse {
void update_capture();
void read();
void get_camera_deltas(float& yaw, float& pitch);
// One shared sample for the existing mouse-as-gyro aiming mode. Neither
// consumer drains SDL's relative state independently of the other.
void get_relative_motion(float& x, float& y);
}
