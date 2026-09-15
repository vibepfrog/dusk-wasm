#pragma once

class dCamera_c;
class scene_class;

namespace dusk::showcase {
void initialize(bool enabled);
bool active() noexcept;
bool controls_locked() noexcept;
bool boot(scene_class* logo);
void prepare_scene();
void campaign_ready();
void update();
void rendered_frame();
void pause();
bool camera(dCamera_c* camera);
}
