def detect_voice_activity(audio_data, sample_rate, threshold=0.003):  # Even lower threshold
    """
    Highly sensitive voice activity detection optimized for medical consultations.
    
    Args:
        audio_data: numpy array of audio samples
        sample_rate: sampling rate of the audio
        threshold: energy threshold for voice detection (very low for high sensitivity)
    
    Returns:
        bool: True if voice activity detected, False otherwise
    """
    # Convert to float and normalize
    audio_float = audio_data.astype(np.float32) / 32768.0
    
    # Apply a pre-emphasis filter to enhance high frequencies (speech)
    pre_emphasized = np.append(audio_float[0], audio_float[1:] - 0.97 * audio_float[:-1])
    
    # Calculate short-term energy with small overlapping frames
    frame_length = int(0.015 * sample_rate)  # 15ms frames for faster detection
    overlap = int(frame_length * 0.75)  # 75% overlap for smoother detection
    
    # Calculate energy for overlapping frames
    energies = []
    for i in range(0, len(pre_emphasized) - frame_length, frame_length - overlap):
        frame = pre_emphasized[i:i + frame_length]
        # Apply Hamming window for better frequency resolution
        frame = frame * np.hamming(len(frame))
        energy = np.sum(frame ** 2) / frame_length
        energies.append(energy)
    
    # Dynamic threshold adjustment with noise floor estimation
    if len(energies) > 0:
        energies = np.array(energies)
        noise_floor = np.percentile(energies, 10)  # Estimate noise floor
        mean_energy = np.mean(energies)
        # Adaptive threshold that considers both noise floor and mean energy
        threshold = min(threshold, max(noise_floor * 2.5, mean_energy * 0.3))
    
    # Check for voice activity with hysteresis
    energy_threshold = np.mean(energies > threshold)
    return energy_threshold > 0.15  # Return true if 15% of frames have voice activity